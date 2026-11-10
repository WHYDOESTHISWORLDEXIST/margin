---
name: review
description: Show everything Claude has changed in the project, plus open margin notes, and undo any change. Use when the writer runs /margin:review or asks what Claude changed, wants to undo something, or wants to see pending notes.
argument-hint: "[undo <number> | notes | dismiss <id>]"
allowed-tools: Bash(node *)
---

# Review: what Claude did

The writer typed: `$ARGUMENTS`

- `undo <number>`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" undo <number>` and report the result in one line.
- `dismiss <id>`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/suggestions.mjs" dismiss <id>`.
- `notes`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/suggestions.mjs" list` and show the notes as a table.

With nothing typed, show both views:

1. **Changes:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/review.mjs" list`. Show them as a table with **#**, **When**, **Change**, **File** and **Can undo**.
2. **Margin notes:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/suggestions.mjs" list`. Show them as a table with **Id**, **Kind**, **Where** and **Note**.

Then one line on how to act: "Undo with `/margin:review undo 3`, dismiss a note with `/margin:review dismiss a1b2c3`."

Undo restores the backup taken just before that change. If later changes touched the same file, they're rolled back too, so say so before undoing in that case and ask first. Files Claude created are moved to `.margin/trash`, never deleted.
