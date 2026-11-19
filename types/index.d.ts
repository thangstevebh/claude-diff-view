export type FileRow = { path: string; code: string; add: number; del: number }
export type Snapshot = {
  isRepo: boolean
  branch: string
  files: FileRow[]
  staged: FileRow[]
  log: string[]
}
export type CallRow = { id: string; tool: string; target: string; isDone: boolean }
export type Tab = 'diff' | 'staged' | 'log' | 'calls' | 'todos'
export type TodoRow = {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

declare module 'claude-code' {
  interface PluginState {
    'diffview': {
      snapshot: Shaped<Snapshot>
      tab: Tab
      cursor: number
      expanded: Shaped<string[]>
      hunks: Shaped<Record<string, string>>
      calls: Shaped<CallRow[]>
      todos: Shaped<TodoRow[]>
      adding: boolean
    }
  }
}
