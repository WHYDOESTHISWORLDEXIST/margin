---
name: organize
description: Tidy a writing project's files into a clear folder layout. Proposes a plan first, moves nothing without approval, never deletes, and can undo. Use when the writer runs /margin:organize or asks to clean up, sort or organize their files or notes.
argument-hint: "[folder] | undo"
allowed-tools: Bash(node *)
---

# Organize the project

The writer typed: `$ARGUMENTS`

If they typed `undo`, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/move.mjs" undo`, report the result and stop.

## 1. Look

Run the inventory. It lists files by kind, date and size, plus identical copies, without opening them:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/inventory.mjs" $ARGUMENTS`

Read the settings for the folder names the writer already chose:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" show`

## 2. Propose

Suggest a simple layout that matches how they already work. Keep any folder names they use. A sensible default:

- `drafts/`: things they're writing
- `notes/`: their own notes, interviews, ideas
- `sources/`: PDFs, the bibliography, clippings
- `archive/`: old versions and finished pieces

Show the plan as a table with the columns **File**, **Moves to** and **Why**, grouped by destination. Rules for the plan:

- Move only files whose place is clearly wrong. Leave the rest alone.
- Never rename a file's base name unless the writer asks.
- For identical copies, propose moving the extras to `archive/duplicates/`. Never delete.
- Leave hidden folders, config files and code alone.
- If a file's purpose is unclear from its name, list it under "Not sure" and ask, rather than guessing.

Then ask for approval with the AskUserQuestion tool: "Move all", "Let me pick" or "Not now".

## 3. Move (only after approval)

Write the approved moves to `.margin/plan.json` as a JSON list of `{"from": "...", "to": "..."}` with project-relative paths, then run:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/move.mjs" apply .margin/plan.json`

The script refuses to overwrite anything and logs every batch. Report what moved, and tell the writer that `/margin:organize undo` puts the last batch back.
