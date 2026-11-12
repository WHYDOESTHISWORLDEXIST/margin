---
name: focus
description: Choose exactly which files and folders Claude may read, so it pulls only from the sources the writer picked. Use when the writer runs /margin:focus, or says things like "only use these files", "don't read my other notes", "just look at chapter 3".
argument-hint: "[add <paths> | remove <paths> | on | off | clear]"
allowed-tools: Bash(node *), PowerShell(node *), Glob
---

# Focus: pick which files Claude may read

While focus is on, hooks keep Claude's reading inside the picked list. Outside it, the Read and Grep tools are blocked, and so are shell commands that read files (`cat`, `head`, `sed`, `grep -r`, `rg`, `Get-Content`, `Select-String` and the like). When a command might read an outside file but Margin can't be sure (a one-line script or another program naming the file, a file name in a variable), the writer is asked first. File and folder names stay visible, and Margin can't see inside programs that open files on their own. Margin's own settings and lists in `.margin/` stay readable; its backups (`.margin/history/`, `.margin/trash/`) don't, since they hold copies of the writer's files. Focus limits what Claude reads, not what it writes, and it doesn't cover shell programs that open files by themselves (a script, `git log -p`). A focus list that has been set is enforced even in a project where `/margin:setup` was never run.

The writer typed: `$ARGUMENTS`

Before any command that changes focus (anything but `status`), run `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" --project "${CLAUDE_PROJECT_DIR}" ensure`. It prints nothing unless it had to set Margin up in this project.

## If they gave a command

Run it with the command and paths they typed, each path in its own double quotes so a name with spaces stays one path, and show the result as is:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/focus.mjs" --project "${CLAUDE_PROJECT_DIR}" <command> "<path>" "<path>"`

For example, `/margin:focus add old drafts/ch 1.md notes` becomes `add "old drafts/ch 1.md" "notes"` when those are the files that exist; check with Glob if you're unsure where one name ends.

Commands: `status`, `add <path...>`, `remove <path...>`, `on`, `off`, `clear`. Adding the first path turns focus on automatically.

Three messages need a word from you. If `add` says `Not found … Nothing was added`, tell the writer in one line which names weren't found; focus is unchanged. If `remove` says `Not in the list: …`, those names weren't in the list, so nothing changed for them. If any command begins by saying the focus list was damaged and repaired, keep that message: until the repair, Claude's reading was paused (never its edits), and a copy of the old list is kept in `.margin/`.

## If they gave nothing, or described it in words

1. Show the current state: `node "${CLAUDE_PLUGIN_ROOT}/scripts/focus.mjs" --project "${CLAUDE_PROJECT_DIR}" status`
2. If they described what they want ("just chapter 3 and my interview notes"), find the matching paths with Glob, then confirm the exact list in one short sentence before adding.
3. If they said nothing, list the project's top-level folders and likely draft and notes files, then ask which to include with the AskUserQuestion tool (multiSelect). Offer "Turn focus off" as an option when it's on.
4. Run the matching `add`, `remove`, `on` or `off` command.

## Rules

- Never add paths the writer didn't choose, even if a file looks relevant. Suggest it instead.
- When the guard blocks a read, tell the writer which file you wanted and why, and let them decide whether to add it. Don't try another tool or command to reach it.
- Keep replies short: the resulting list is the answer.
