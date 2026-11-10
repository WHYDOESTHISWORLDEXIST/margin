---
name: cite
description: Check a draft's citations against the writer's own bibliography (for example a Zotero Better BibTeX export), find typos in citation keys, and fix them only with approval. Never invents a source. Use when the writer runs /margin:cite or asks about missing, broken or unresolved citations.
argument-hint: "[draft file] [library.bib]"
allowed-tools: Bash(node *), Read
---

# Check citations

The writer typed: `$ARGUMENTS`

1. Run the checker. The bibliography comes from the arguments, then from the `bibliography` setting, then from the first `.bib` file in the project:

   `node "${CLAUDE_PLUGIN_ROOT}/scripts/cite-check.mjs" --project "${CLAUDE_PROJECT_DIR}" $ARGUMENTS`

2. If no library was found, say so in one line and suggest exporting one from Zotero with Better BibTeX, then saving its path with `/margin:setup`. Stop there.

3. Report: "X of Y citations found in your library." Then, for each unresolved key, one row in a table: **Line**, **Key**, **Likely meant**, with the close match from the library or "not in library".

4. Offer to fix only the keys that have a single clear close match. Ask with the AskUserQuestion tool ("Fix these", "Let me pick", "Leave them"). After approval, make exact key replacements in the draft with the Edit tool. Every edit is backed up automatically and can be undone with `/margin:review`.

## Never

- Never invent a citation, a reference, a page number or a source that isn't in the writer's library.
- Never guess between two close matches. Ask.
- Never reformat the bibliography or change citation style.

For keys that aren't in the library at all, queue a margin note instead of guessing:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/suggestions.mjs" --project "${CLAUDE_PROJECT_DIR}" add '{"file":"<draft>","line":<n>,"kind":"citation","message":"@<key> isn’t in your library."}'`
