---
name: review
description: Show everything Claude has changed in the project, plus open margin notes, and undo any change. Use when the writer runs /margin:review or asks what Claude changed, wants to undo something, or wants to see pending notes.
argument-hint: "[undo <number> | notes | dismiss <id>]"
allowed-tools: Bash(node *), PowerShell(node *)
---

# Review: what Claude did

The writer typed: `$ARGUMENTS`

Before `undo` or `dismiss`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" --project "${CLAUDE_PROJECT_DIR}" ensure`. It prints nothing unless it had to set Margin up in this project.

- `undo <number>`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" --project "${CLAUDE_PROJECT_DIR}" undo <number>` and report the result in one line.
  If it refuses (exit code 2: later changes touched the same file, or the file changed since Claude's change), show its explanation as it is, then ask once with the AskUserQuestion tool: "Undo anyway (the current version is kept)" or "Leave it as it is". Only if they choose to go ahead, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" --project "${CLAUDE_PROJECT_DIR}" undo <number> --go-ahead` and report the result in one line. Never add `--go-ahead` on your own.
- `dismiss <id>`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/suggestions.mjs" --project "${CLAUDE_PROJECT_DIR}" dismiss <id>`.
- `notes`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/suggestions.mjs" --project "${CLAUDE_PROJECT_DIR}" list` and show the notes as a table.

With nothing typed, show both views:

1. **Changes:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" --project "${CLAUDE_PROJECT_DIR}" list`. Show them as a table with **#**, **When** (the writer's local time), **Change**, **File** and **Can undo**. **Change** is `created`, `edited`, `undone`, or `undid #…` for an undo. **Can undo** is `yes`, `no`, `no backup`, `with later changes`, or `backup cleared <date>`: old backups are cleared to save space (see below), and the change stays listed.
2. **Margin notes:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/suggestions.mjs" --project "${CLAUDE_PROJECT_DIR}" list`. Show them as a table with **Id**, **Kind**, **Where** and **Note**.

Then one line on how to act: "Undo with `/margin:review undo 3`, dismiss a note with `/margin:review dismiss a1b2c3`."

Only changes made with Claude's file tools (Edit, Write, MultiEdit, NotebookEdit) are listed and backed up. Changes made through shell commands (`sed -i`, redirects, `mv`) are not, so say so if the writer asks about one.

Undo restores the backup taken before that change. If the result says the backup was cleared, tell the writer that change can't be undone here. If it says the file is open in another program, tell the writer to close it and run undo again; nothing was changed. If it says Claude has not changed any files yet, there is nothing to undo. It first keeps the current version and lists the undo as a change of its own, so an undo can be undone too. It won't silently roll back later changes to the same file or edits made since; it explains and waits for a go-ahead. Files Claude created are moved to `.margin/trash`, never deleted.
