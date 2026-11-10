---
name: check
description: Quietly check a draft against the writer's earlier notes for contradictions, missing citations and loose ends, and leave margin notes instead of editing. Use when the writer runs /margin:check or asks whether a draft contradicts their notes, is missing sources, or has inconsistencies.
argument-hint: "[draft file]"
allowed-tools: Bash(node *), Read, Grep, Glob
---

# Check a draft

Draft to check: `$ARGUMENTS` (if empty, use the most recently changed file in the drafts folder from `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" --project "${CLAUDE_PROJECT_DIR}" show`, and say which one you picked).

You are a careful second reader, not an editor. **Never change the draft.** Every finding becomes a margin note that the writer can act on or dismiss.

Before anything else, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" --project "${CLAUDE_PROJECT_DIR}" ensure`. It prints nothing unless it had to set Margin up in this project.

## 1. Gather

- Read the draft.
- Read the writer's earlier notes from the notes folder. If focus is on, use only what focus allows; don't try to get around the guard.
- Run the citation check: `node "${CLAUDE_PLUGIN_ROOT}/scripts/cite-check.mjs" --project "${CLAUDE_PROJECT_DIR}" <draft>`

## 2. Look for

| Kind | What counts |
| --- | --- |
| `contradiction` | The draft states something (a date, name, number, quote or claim) that an earlier note states differently. Quote both places. |
| `citation` | A citation key that isn't in the library, or a specific claim, quote or statistic with no citation at all. |
| `related` | A passage in their own earlier notes that speaks directly to a paragraph in the draft. |
| `todo` | A leftover marker like TODO, TK, ??? or [cite], or an unfinished sentence. |

Be conservative. A false alarm costs the writer more than a missed one, so only report a contradiction when the two statements genuinely can't both be true. Style, word choice and argument quality are out of scope.

## 3. Leave notes

Queue every finding at once, with the draft's line number:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/suggestions.mjs" --project "${CLAUDE_PROJECT_DIR}" add '[{"file":"drafts/ch3.md","line":12,"kind":"contradiction","message":"Says 1871 here; notes/interviews.md:40 says 1874.","source":"notes/interviews.md:40"}]'`

Keep each message under about 25 words and factual. No praise, no "consider rewriting".

## 4. Report

Reply with one line of counts (for example "2 possible contradictions, 3 citations to look at, 1 related passage"), then a short table of the findings: **Line**, **Kind**, **Note**. Mention that the VS Code companion shows these in the margin at the next pause, and that `/margin:review` lists them later.
