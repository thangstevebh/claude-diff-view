import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CallRow, FileRow, Snapshot, Tab, TodoRow } from '../types'

const PANE = 'diffview'
const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
const MAX_HUNK_LINES = 200

const empty: Snapshot = { isRepo: true, branch: '', files: [], staged: [], log: [] }

const snapshot = atom({ plugin: 'diffview', key: 'snapshot' } as const, empty, {
  shape: 'snapshot-1',
})
const tab = atom({ plugin: 'diffview', key: 'tab' } as const, 'diff' as Tab)
const expanded = atom({ plugin: 'diffview', key: 'expanded' } as const, [], {
  shape: 'expanded-1',
})
const hunks = atom({ plugin: 'diffview', key: 'hunks' } as const, {}, {
  shape: 'hunks-1',
})
const cursor = atom({ plugin: 'diffview', key: 'cursor' } as const, 0)
const todos = atom({ plugin: 'diffview', key: 'todos' } as const, [], {
  shape: 'todos-1',
})
const calls = atom({ plugin: 'diffview', key: 'calls' } as const, [], {
  shape: 'calls-1',
})
const adding = atom({ plugin: 'diffview', key: 'adding' } as const, false)
const committing = atom({ plugin: 'diffview', key: 'committing' } as const, false)
const draft = atom({ plugin: 'diffview', key: 'draft' } as const, '')

const git = ($: EngineInterface, args: string[]) =>
  $.process.run(['git', ...args], { timeoutMs: 8000 })

const parseNumstat = (out: string): FileRow[] =>
  out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [add, del, ...rest] = line.split('\t')

      return {
        path: rest.join('\t'),
        code: 'M',
        add: Number(add) || 0,
        del: Number(del) || 0,
      }
    })

const parseStatus = (out: string): Map<string, string> => {
  const codes = new Map<string, string>()
  for (const line of out.split('\n').filter(Boolean)) {
    const raw = line.slice(0, 2).replace(/\s/g, '')
    const code = raw === '??' ? 'A' : raw.charAt(raw.length - 1) || 'M'
    codes.set(line.slice(3), code)
  }

  return codes
}

const hunkKey = (which: Tab, path: string) => `${which}:${path}`

const loadHunk = async ($: EngineInterface, which: Tab, row: FileRow) => {
  const args =
    which === 'staged'
      ? ['diff', '--cached', '--', row.path]
      : row.code === 'A' && row.add === 0
        ? ['diff', '--no-index', '--', '/dev/null', row.path]
        : ['diff', 'HEAD', '--', row.path]
  const ran = await git($, args)
  const lines = ran.stdout.split('\n')
  const body = lines.slice(lines.findIndex(l => l.startsWith('@@')) >>> 0)
  const text = body.slice(0, MAX_HUNK_LINES).join('\n')
  await update($, hunks, all => ({ ...all, [hunkKey(which, row.path)]: text }))
}

const STATUSES = new Set<TodoRow['status']>(['pending', 'in_progress', 'completed'])

const NEXT_STATUS: Record<TodoRow['status'], TodoRow['status']> = {
  pending: 'in_progress',
  in_progress: 'completed',
  completed: 'pending',
}

const taskDir = async ($: EngineInterface) => {
  const home = await $.env.get('HOME')

  return home ? `${home}/.claude/tasks/${await $.session.id()}` : undefined
}

const cycleTodo = async ($: EngineInterface, row: TodoRow) => {
  const status = NEXT_STATUS[row.status]
  try {
    const dir = await taskDir($)
    const file = dir && `${dir}/${row.id}.json`
    if (file && (await $.fs.exists(file))) {
      const task = JSON.parse(await $.fs.read(file))
      await $.fs.write(file, `${JSON.stringify({ ...task, status }, null, 2)}\n`)
    }
  } catch {
    $.ui.log('diffview: todo write failed', { to: 'debug' })
  }
  await update($, todos, list => list.map(t => (t.id === row.id ? { ...t, status } : t)))
}

const addTodo = async ($: EngineInterface, current: TodoRow[], text: string) => {
  const id = String(Math.max(0, ...current.map(t => Number(t.id) || 0)) + 1)
  try {
    const dir = await taskDir($)
    if (dir && (await $.fs.exists(dir))) {
      const task = {
        id,
        subject: text,
        description: '',
        activeForm: text,
        status: 'pending',
        blocks: [],
        blockedBy: [],
      }
      await $.fs.write(`${dir}/${id}.json`, `${JSON.stringify(task, null, 2)}\n`)
    }
  } catch {
    $.ui.log('diffview: todo write failed', { to: 'debug' })
  }
  await update($, todos, list => [...list, { id, text, status: 'pending' as const }])
  await update($, cursor, () => current.length)
  await update($, adding, () => false)
  try {
    await $.ui.focus({ requestId: PANE, key: `todo:${id}` })
  } catch {
    $.ui.log('diffview: focus after add failed', { to: 'debug' })
  }
}

const syncTodos = async ($: EngineInterface) => {
  try {
    const dir = await taskDir($)
    if (!dir || !(await $.fs.exists(dir))) {
      return
    }
    const names = (await $.fs.list(dir)).map(f => f.name).filter(n => n.endsWith('.json'))
    const rows: TodoRow[] = []
    for (const name of names) {
      const task = JSON.parse(await $.fs.read(`${dir}/${name}`))
      if (typeof task.subject === 'string' && STATUSES.has(task.status)) {
        rows.push({ id: String(task.id ?? name), text: task.subject, status: task.status })
      }
    }
    if (rows.length > 0) {
      rows.sort((a, b) => Number(a.id) - Number(b.id))
      await update($, todos, () => rows)
    }
  } catch {
    $.ui.log('diffview: todo sync failed', { to: 'debug' })
  }
}

let busy = false

const refresh = async ($: EngineInterface) => {
  if (busy) {
    return
  }
  const open = await $.ui.panes()
  if (!open.some(p => p.id === PANE)) {
    return
  }
  await syncTodos($)
  busy = true
  try {
    const inside = await git($, ['rev-parse', '--is-inside-work-tree'])
    if (inside.exitCode !== 0) {
      await update($, snapshot, () => ({ ...empty, isRepo: false }))

      return
    }
    const [status, unstaged, cached, log, branch] = await Promise.all([
      git($, ['status', '--porcelain=v1']),
      git($, ['diff', 'HEAD', '--numstat']),
      git($, ['diff', '--cached', '--numstat']),
      git($, ['log', '-20', '--pretty=format:%h\t%s\t%ar']),
      git($, ['branch', '--show-current']),
    ])
    const codes = parseStatus(status.stdout)
    const counted = parseNumstat(unstaged.stdout)
    const seen = new Set(counted.map(r => r.path))
    const files = [
      ...counted.map(r => ({ ...r, code: codes.get(r.path) ?? 'M' })),
      ...[...codes]
        .filter(([path]) => !seen.has(path))
        .map(([path, code]) => ({ path, code, add: 0, del: 0 })),
    ]
    await update($, snapshot, () => ({
      isRepo: true,
      branch: branch.stdout.trim(),
      files,
      staged: parseNumstat(cached.stdout),
      log: log.stdout.split('\n').filter(Boolean),
    }))
    const keys = await read($, expanded)
    const current = await read($, tab)
    for (const path of keys) {
      const row = (current === 'staged' ? parseNumstat(cached.stdout) : files).find(
        r => r.path === path,
      )
      if (row && (current === 'diff' || current === 'staged')) {
        await loadHunk($, current, row)
      }
    }
  } finally {
    busy = false
  }
}

const firstLine = (text: string) => text.split('\n').find(l => l.trim()) ?? ''

const stagePath = async ($: EngineInterface, path: string) => {
  const r = await git($, ['add', '--', path])
  if (r.exitCode !== 0) {
    $.ui.toast(`git add failed: ${firstLine(r.stderr)}`)
  }
  await refresh($)
}

const stageAll = async ($: EngineInterface) => {
  const r = await git($, ['add', '-A'])
  if (r.exitCode !== 0) {
    $.ui.toast(`git add failed: ${firstLine(r.stderr)}`)
  }
  await refresh($)
}

const unstagePath = async ($: EngineInterface, path: string) => {
  let r = await git($, ['restore', '--staged', '--', path])
  if (r.exitCode !== 0) {
    r = await git($, ['rm', '--cached', '-q', '--', path])
  }
  if (r.exitCode !== 0) {
    $.ui.toast(`unstage failed: ${firstLine(r.stderr)}`)
  }
  await refresh($)
}

const doCommit = async ($: EngineInterface, message: string) => {
  const text = message.trim()
  if (!text) {
    $.ui.toast('Commit message is empty.')

    return
  }
  const r = await $.process.run(['git', 'commit', '-m', text], { timeoutMs: 60000 })
  if (r.exitCode !== 0) {
    $.ui.toast(`commit failed: ${firstLine(r.stderr) || firstLine(r.stdout)}`)

    return
  }
  $.ui.toast(`Committed: ${firstLine(r.stdout)}`)
  await update($, draft, () => '')
  await update($, committing, () => false)
  await refresh($)
}

const suggestMessage = async ($: EngineInterface) => {
  const diff = await git($, ['diff', '--cached', '--no-color'])
  if (!diff.stdout.trim()) {
    $.ui.toast('Nothing staged.')

    return
  }
  $.ui.toast('Drafting a commit message…')
  const r = await $.model
    .complete({
      model: 'haiku',
      prompt: `Write a concise git commit message for this staged diff: an imperative subject of at most 72 characters, then an optional short body. Reply with the message only.\n\n${diff.stdout.slice(0, 12000)}`,
    })
    .catch(() => undefined)
  if (!r?.isAnswered) {
    $.ui.toast('Could not draft a message.')

    return
  }
  await update($, draft, () => r.text.trim())
  await update($, committing, () => true)
  await $.ui.focus({ requestId: PANE, key: 'commit-msg' }).catch(() => undefined)
}

const TABS: { id: Tab; label: string; hotkey: string }[] = [
  { id: 'diff', label: 'Diff', hotkey: '1' },
  { id: 'staged', label: 'Staged', hotkey: '2' },
  { id: 'log', label: 'Log', hotkey: '3' },
  { id: 'calls', label: 'Calls', hotkey: '4' },
  { id: 'todos', label: 'Todos', hotkey: '5' },
]

const TODO_ICON: Record<TodoRow['status'], string> = {
  pending: '○',
  in_progress: '▶',
  completed: '✓',
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'diffview',
      description: 'Show or hide the diff pane',
    })
    void $.ui.open({ id: PANE, title: 'Diff', columns: 72, backgroundColor: 'transparent' })
    $.clock.every(3000, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'diffview' }, async $ => {
    const open = await $.ui.panes()
    if (open.some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })

      return { text: 'Diff view hidden.' }
    }
    await $.ui.open({
      id: PANE,
      title: 'Diff',
      columns: 72,
      focus: true,
      backgroundColor: 'transparent',
    })
    void refresh($)

    return { text: 'Diff view shown.' }
  })

  on('tool.call', async ($, e, next) => {
    const target = String(Reflect.get(e, 'file_path') ?? Reflect.get(e, 'command') ?? '')
    const row: CallRow = { id: e.tool_use_id, tool: e.tool, target, isDone: false }
    await update($, calls, list => [...list, row].slice(-100))
    const ran = await next(e)
    try {
      if (e.tool === 'TodoWrite') {
        const list: TodoRow[] = e.todos.map((t, i) => ({
          id: String(i),
          text: t.content,
          status: t.status,
        }))
        await update($, todos, () => list)
      } else if (e.tool === 'TaskCreate') {
        const made = Reflect.get(Reflect.get(ran, 'result') ?? {}, 'task')
        const id = String(Reflect.get(made ?? {}, 'id') ?? e.tool_use_id)
        await update($, todos, list => [
          ...list,
          { id, text: e.subject, status: 'pending' as const },
        ])
      } else if (e.tool === 'TaskUpdate') {
        const { status, taskId, subject } = e
        await update($, todos, list =>
          status === 'deleted'
            ? list.filter(t => t.id !== taskId)
            : list.map(t =>
                t.id === taskId
                  ? { ...t, text: subject ?? t.text, status: status ?? t.status }
                  : t,
              ),
        )
      }
      await update($, calls, list =>
        list.map(one => (one.id === row.id ? { ...one, isDone: true } : one)),
      )
      if (WRITERS.has(e.tool)) {
        void refresh($)
      }
    } catch {
      $.ui.log('diffview: bookkeeping failed', { to: 'debug' })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    if (e.element !== 'new-todo' && (await read($, adding))) {
      await update($, adding, () => false)
    }
    if (e.element !== 'commit-msg' && (await read($, committing))) {
      await update($, committing, () => false)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const active = await read($, tab)
    const open = await read($, expanded)
    const bodies = await read($, hunks)
    const recent = await read($, calls)
    const items = await read($, todos)
    const isAdding = await read($, adding)
    const isCommitting = await read($, committing)
    const draftText = await read($, draft)
    const at = await read($, cursor)
    const width = Math.max(20, (e.props.bodyColumns ?? 40) - 2)
    const rows = active === 'staged' ? snap.staged : snap.files
    const add = rows.reduce((n, r) => n + r.add, 0)
    const del = rows.reduce((n, r) => n + r.del, 0)

    const listed = active === 'diff' || active === 'staged'
    const count = active === 'todos' ? items.length : rows.length
    const sel = Math.min(Math.max(at, 0), Math.max(count - 1, 0))
    const move = async (step: number) => {
      const to = Math.min(Math.max(sel + step, 0), Math.max(count - 1, 0))
      await update($, cursor, () => to)
      const row = rows[to]
      if (listed && row) {
        await $.ui.focus({ requestId: PANE, key: `file:${row.path}` })
      }
      const item = items[to]
      if (active === 'todos' && item) {
        await $.ui.focus({ requestId: PANE, key: `todo:${item.id}` })
      }
    }
    const startAdd = async () => {
      await update($, tab, () => 'todos' as Tab)
      await update($, adding, () => true)
      await $.ui.focus({ requestId: PANE, key: 'new-todo' })
    }
    const picked = rows[sel]
    const startCommit = async () => {
      await update($, tab, () => 'staged' as Tab)
      await update($, committing, () => true)
      await $.ui.focus({ requestId: PANE, key: 'commit-msg' })
    }
    const go = async (id: Tab) => {
      await update($, tab, () => id)
      await update($, adding, () => false)
      await update($, cursor, () => 0)
      const first = (id === 'staged' ? snap.staged : id === 'diff' ? snap.files : [])[0]
      if (first) {
        await $.ui.focus({ requestId: PANE, key: `file:${first.path}` })
      }
      const firstTodo = items[0]
      if (id === 'todos' && firstTodo) {
        await $.ui.focus({ requestId: PANE, key: `todo:${firstTodo.id}` })
      }
    }
    const shift = (step: number) => {
      const i = TABS.findIndex(t => t.id === active)
      const next = TABS[(i + step + TABS.length) % TABS.length]
      return next ? go(next.id) : undefined
    }

    const toggle = async (which: Tab, row: FileRow) => {
      const isOpen = open.includes(row.path)
      await update($, expanded, list =>
        isOpen ? list.filter(p => p !== row.path) : [...list, row.path],
      )
      if (!isOpen) {
        await loadHunk($, which, row)
      }
    }

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Box>
            {TABS.map(t => (
              <Button
                key={`tab:${t.id}`}
                label={t.label}
                hotkey={t.hotkey}
                variant={t.id === active ? 'primary' : 'secondary'}
                onPress={() => go(t.id)}
              />
            ))}
            <Button key="refresh" label="↻" hotkey="r" onPress={() => void refresh($)} />
          </Box>
          <Button
            key="close"
            label="✕ Đóng"
            hotkey="x"
            onPress={() => $.ui.close({ id: PANE })}
          />
        </Box>
        <Box>
          <Button key="k-down" plain label="↓" hotkey="j" onPress={() => move(1)} />
          <Text> </Text>
          <Button key="k-up" plain label="↑" hotkey="k" onPress={() => move(-1)} />
          <Text> </Text>
          <Button key="k-prev" plain label="◀" hotkey="h" onPress={() => shift(-1)} />
          <Text> </Text>
          <Button key="k-next" plain label="▶" hotkey="l" onPress={() => shift(1)} />
          <Text> </Text>
          <Button key="k-add" plain label="＋" hotkey="a" onPress={() => startAdd()} />
          <Text dimColor> · Enter: mở · a: thêm todo · Esc: về chat</Text>
        </Box>

        {snap.isRepo && active === 'diff' && (
          <Box>
            <Button
              key="stage"
              label="Stage"
              hotkey="s"
              onPress={() => (picked ? void stagePath($, picked.path) : undefined)}
            />
            <Text> </Text>
            <Button key="stage-all" label="Stage all" hotkey="g" onPress={() => void stageAll($)} />
          </Box>
        )}
        {snap.isRepo && active === 'staged' && (
          <Box flexDirection="column">
            <Box>
              <Button
                key="unstage"
                label="Unstage"
                hotkey="u"
                onPress={() => (picked ? void unstagePath($, picked.path) : undefined)}
              />
              <Text> </Text>
              <Button key="commit" label="Commit" hotkey="c" onPress={() => void startCommit()} />
              <Text> </Text>
              <Button key="suggest" label="Suggest" hotkey="m" onPress={() => void suggestMessage($)} />
            </Box>
            {isCommitting && (
              <Input
                key="commit-msg"
                autoFocus
                label="msg"
                placeholder="Commit message, Enter to commit"
                value={draftText}
                submitLabel="commit"
                onInput={value => void update($, draft, () => value)}
                onSubmit={value => void doCommit($, value)}
              />
            )}
          </Box>
        )}
        {!snap.isRepo && <Text dimColor>Not a git repository.</Text>}

        {snap.isRepo && (active === 'diff' || active === 'staged') && (
          <Box flexDirection="column">
            <Text dimColor>
              {snap.branch || 'detached'} · {rows.length} files{' '}
              <Text color="diffAdded">+{add}</Text>{' '}
              <Text color="diffRemoved">−{del}</Text>
            </Text>
            {rows.length === 0 && <Text dimColor>No changes.</Text>}
            {rows.map((row, index) => {
              const isOpen = open.includes(row.path)
              const body = bodies[hunkKey(active, row.path)]

              return (
                <Box key={`row:${row.path}`} flexDirection="column">
                  <Button
                    key={`file:${row.path}`}
                    plain
                    autoFocus={index === sel ? true : undefined}
                    onPress={() => toggle(active, row)}
                  >
                    {index === sel ? '›' : ' '}{isOpen ? '▾' : '▸'} {row.code} {row.path}{' '}
                    <Text color="diffAdded">+{row.add}</Text>{' '}
                    <Text color="diffRemoved">−{row.del}</Text>
                  </Button>
                  {isOpen &&
                    (body ?? '').split('\n').map((line, i) => (
                      <Text
                        key={`l:${row.path}:${i}`}
                        wrap="truncate-end"
                        dimColor={line.startsWith('@@')}
                        color={
                          line.startsWith('+')
                            ? 'diffAdded'
                            : line.startsWith('-')
                              ? 'diffRemoved'
                              : undefined
                        }
                      >
                        {line.slice(0, width)}
                      </Text>
                    ))}
                </Box>
              )
            })}
          </Box>
        )}

        {snap.isRepo && active === 'log' && (
          <Box flexDirection="column">
            {snap.log.length === 0 && <Text dimColor>No commits yet.</Text>}
            {snap.log.map(line => {
              const [hash, subject, age] = line.split('\t')

              return (
                <Text key={`c:${hash}`} wrap="truncate-end">
                  <Text color="warning">{hash}</Text> {subject}{' '}
                  <Text dimColor>{age}</Text>
                </Text>
              )
            })}
          </Box>
        )}

        {active === 'todos' && (
          <Box flexDirection="column">
            <Text dimColor>
              {items.filter(t => t.status === 'completed').length}/{items.length} done
            </Text>
            {isAdding && (
              <Input
                key="new-todo"
                autoFocus
                label="＋"
                placeholder="Tên todo, Enter để thêm"
                submitLabel="thêm"
                onSubmit={value => {
                  const text = value.trim()
                  if (text) {
                    void addTodo($, items, text)
                  } else {
                    void update($, adding, () => false)
                  }
                }}
              />
            )}
            {items.length === 0 && !isAdding && <Text dimColor>No todos yet.</Text>}
            {items.map((t, index) => (
              <Button
                key={`todo:${t.id}`}
                plain
                autoFocus={index === sel ? true : undefined}
                onPress={() => cycleTodo($, t)}
              >
                <Text
                  wrap="truncate-end"
                  dimColor={t.status === 'completed'}
                  color={t.status === 'in_progress' ? 'warning' : undefined}
                >
                  {index === sel ? '›' : ' '} {TODO_ICON[t.status]} {t.text}
                </Text>
              </Button>
            ))}
          </Box>
        )}

        {active === 'calls' && (
          <Box flexDirection="column">
            {recent.length === 0 && <Text dimColor>No tool calls yet.</Text>}
            {recent
              .slice(-Math.max(1, (e.props.scroll?.bodyRows ?? 24) - 3))
              .map(call => (
                <Text key={`t:${call.id}`} wrap="truncate-end" dimColor={call.isDone}>
                  {call.isDone ? '✓' : '…'} {call.tool} {call.target}
                </Text>
              ))}
          </Box>
        )}
      </Box>
    )
  })
}
