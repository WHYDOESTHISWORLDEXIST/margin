---
name: pause
description: Offer a short break when the writer feels stuck, with a choice of a very short story, a walk, something quiet, or a minute of noticing. Use only when the writer runs /margin:pause or asks for a break, a story, or help getting unstuck.
argument-hint: "[story | walk | quiet | notice] [setting: ...] [symbol: ...] [flash | short | long]"
disable-model-invocation: true
allowed-tools: Bash(node *), PowerShell(node *)
---

# A short break

The writer typed: `$ARGUMENTS`

Breaks work best when they're light and don't use words much, and when the writer chooses them. Never say "you seem stuck", never lecture about productivity, and keep everything short.

## If they didn't pick

Offer four options with the AskUserQuestion tool:

- **A very short story**: about a minute to read
- **A short walk**: five minutes away from the screen
- **Something quiet**: watch or listen to something calm
- **Just notice**: a minute with eyes off the page

## Story

If they didn't type a length, first read the `storyLength` setting (it prints the settings and changes nothing):

`node "${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs" --project "${CLAUDE_PROJECT_DIR}" show`

Write one story following every rule below. Then stop: no title, no introduction, no explanation afterward.

- Never name or imply one central problem. Let several small, unrelated things be slightly off at once, so the reader decides which one is theirs.
- Never offer a solution, lesson or realization. No wise mentor, no epiphany, no line that sums things up.
- End on a concrete action or image, before anything resolves.
- If they gave a setting, the story happens there, but the setting must not hint at a way out.
- If they gave a symbol, it appears at least twice, may change slightly, and is never explained or used as an answer.
- Length: the one they typed, else the `storyLength` setting, else `short`. `flash` is about 120 to 180 words with 2 threads; `short` about 300 to 450 words with 4 threads; `long` about 1,000 to 1,400 words with 6 threads.
- Vary the form between stories (plain prose, letters, dialogue only, a list, second person). Don't reuse images from earlier stories in this conversation.
- Never base the story on the writer's draft or its problems.

After the story, add one quiet line, set apart: *Want to write a few lines? Pick "about the story", "something else", or "blank page", or just go back to your draft.* If they choose one, give a single prompt: an invitation about the story ("Write what's in the box marked KEEP"), an unrelated everyday prompt, or none. Don't comment on what they write unless they ask, and never connect it to their draft.

## Walk

One or two sentences: five minutes is plenty, indoors is fine, no need to think about the draft. Their draft will be right where they left it.

## Quiet

Suggest one: look out of a window for a minute; play a few minutes of calm instrumental music; or open the VS Code companion's quiet panel with the command "Margin: Something quiet".

## Notice

A few lines inviting them to look away from the screen for a minute and notice sounds, light and how they're sitting. Nothing to get right.
