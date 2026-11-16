---
name: cite
description: Check a draft's citations against the writer's own bibliography (for example a Zotero Better BibTeX export), find typos in citation keys, and fix them only with approval. Never invents a source. Use when the writer runs /margin:cite or asks about missing, broken or unresolved citations.
argument-hint: "[draft file] [library.bib]"
allowed-tools: Bash(node *), PowerShell(node *), Read
---

# Check citations

The writer typed: `$ARGUMENTS`

1. Make sure Margin is set up here, so any fix below is backed up. It prints nothing unless it had to set Margin up in this project:

   `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" --project "${CLAUDE_PROJECT_DIR}" ensure`

2. Run the checker. The bibliography comes from the arguments, then from the `bibliography` setting, then from the newest `.bib` file in the project:

   `node "${CLAUDE_PLUGIN_ROOT}/scripts/cite-check.mjs" --project "${CLAUDE_PROJECT_DIR}" "<draft>" "<library.bib>"`

   Use the draft and library they named, each in its own double quotes so a name with spaces stays one path; leave out the library if they didn't name one.

   If they named no draft, use the most recently changed file in the drafts folder (the `drafts` setting, from `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" --project "${CLAUDE_PROJECT_DIR}" show`), and say which one you picked.

3. If the checker says there is no draft by that name, tell the writer in one line and stop. If the result has an `error`, say so in one line, list no keys, and stop:
   - `no_library`: no bibliography was found. Suggest exporting one from Zotero with Better BibTeX, then saving its path with `/margin:setup`.
   - `library_missing`: the library named in the command or in setup (`library`) isn't there.
   - `library_empty`: Margin couldn't read any entries in `library`. Suggest checking that it's a BibTeX export.

   If `libraryChosenBy` is `newest` and `libraryCandidates` lists more than one file, say which one you used and that `/margin:setup` can save the right one.

4. Report: "X of Y citations found in your library." Then, for each unresolved key, one row in a table: **Line**, **Key**, **Likely meant**. For **Likely meant**, give the close match from `closeMatchDetails` with its author, year and title (for example "smith2020 — Smith, 2020, Tide Mills"), or "not in library".

   A key with `form: "bare"` is an @name in running text, not in [brackets] or a `\cite`: it may be a mention, like an @handle, rather than a citation. List it separately as "possible mentions", and don't fix it or queue a note for it unless the writer says it's a citation.

5. Offer to fix only the keys that have a single clear close match. Ask with the AskUserQuestion tool ("Fix these", "Let me pick", "Leave them"). After approval, make exact key replacements in the draft with the Edit tool; Claude Code may ask the writer to allow each edit. Every edit is backed up automatically and can be undone with `/margin:review`. If Claude Code asks whether to go ahead because Margin couldn't back the file up first, say so plainly and let the writer decide.

## Never

- Never invent a citation, a reference, a page number or a source that isn't in the writer's library.
- Never guess between two close matches. Ask.
- Never reformat the bibliography or change citation style.

For keys that aren't in the library at all, queue a margin note instead of guessing:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/suggestions.mjs" --project "${CLAUDE_PROJECT_DIR}" add --file "<draft>" --line <n> --kind citation --message "@<key> isn’t in your library."`

Put each value in straight double quotes; inside a message write apostrophes as ’ and never use double quotes of any kind, `$` or backticks. Repeat the flags, starting each note with `--file`, to queue several notes in one command.
