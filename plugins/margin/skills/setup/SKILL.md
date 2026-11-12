---
name: setup
description: Set up Margin for this writing project with a few quick questions, no config files to edit. Use when the writer runs /margin:setup or asks to configure Margin.
disable-model-invocation: true
allowed-tools: Bash(node *), PowerShell(node *), Glob
---

# Set up Margin

Help the writer set up Margin in a minute or two. They should never have to open or edit a config file. Settings live in `.margin/settings.json`, written by a script.

1. Set Margin up in this project (earlier answers are kept; until this runs, Margin's backups stay off here) and show the current settings:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" --project "${CLAUDE_PROJECT_DIR}" init`
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" --project "${CLAUDE_PROJECT_DIR}" show`
2. Look around quickly with Glob (top two folder levels only, plus any `*.bib` file) so you can suggest sensible answers instead of asking blank questions.
3. Ask at most four questions in one go with the AskUserQuestion tool, each with your best guess as the first option:
   - Where do drafts live? (setting `drafts`)
   - Where do notes live? (setting `notes`)
   - Which bibliography file, if any? A Zotero "Better BibTeX" export works best. (setting `bibliography`)
   - Should Margin quietly offer a short break, like a walk or a story, after a long quiet stretch in the editor? (setting `suggestBreaks`)
4. Save each answer:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" --project "${CLAUDE_PROJECT_DIR}" set <key> <value>`
5. Finish with a short welcome that lists what they can do now, one line each:
   - `/margin:focus` to choose which files Claude may read
   - `/margin:organize` to tidy folders (nothing moves without their OK, and moves can be undone)
   - `/margin:check` to look for contradictions and missing citations
   - `/margin:cite` to check citations against their library
   - `/margin:pause` for a short break whenever they want one
   - `/margin:review` to see and undo anything Claude changed

Mention once that `.margin/` holds Margin's settings, backups and notes, and they may want to add it to `.gitignore`. Don't change `.gitignore` yourself unless they say so.
