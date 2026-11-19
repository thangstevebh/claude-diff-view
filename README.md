# diffview

A side pane for Claude Code that shows, next to the chat, what changed in the
working tree. It has five tabs: unstaged diff, staged diff, recent commits,
the tool calls of the session, and the todo list Claude keeps. Files open
inline into colored hunks. It refreshes every three seconds and right after
Claude edits, writes or runs a command.

## Use

- `/diffview` shows or hides the pane. Drag its edge to change the width.
- Give the pane the keyboard with `/diffview`, a click, or ctrl+x then Tab.
  `Esc` returns the keyboard to the prompt.
- Keys while the pane holds the keyboard:
  - `j` / `k` select the next or previous file, `Enter` opens or closes it
  - `h` / `l` go to the previous or next tab, `1`-`5` jump to a tab
  - on the Todos tab, `j` / `k` select a task and `Enter` cycles its status
    (pending, in progress, done); the change is saved to the task file
  - `a` opens a field on the Todos tab; type a name and press `Enter` to add a
    todo (saved as a task file when the session has a tasks folder)
  - `r` refreshes, `x` closes the pane

## Install

In a Claude Code terminal session:

```
/plugin install diffview --marketplace thangstevebh/claude-diff-view
```

From a shell:

```
claude plugin install diffview --marketplace thangstevebh/claude-diff-view
```

The Todos tab also reads `~/.claude/tasks/<session-id>/*.json` on every refresh,
so tasks stored there show up even when no todo tool ran in this session.
Outside a git repository the git tabs show a notice; Calls and Todos still work.
