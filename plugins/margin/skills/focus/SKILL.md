---
name: focus
description: Choose exactly which files and folders Claude may read, so it pulls only from the sources the writer picked. Use when the writer runs /margin:focus, or says things like "only use these files", "don't read my other notes", "just look at chapter 3".
argument-hint: "[add <paths> | remove <paths> | on | off | clear]"
allowed-tools: Bash(node *), Glob
---

# Focus: pick which files Claude may read

While focus is on, a hook blocks Claude from reading or searching anything outside the picked list. Margin's own `.margin/` folder is always readable.

The writer typed: `$ARGUMENTS`

## If they gave a command

Run it and show the result as is:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/focus.mjs" --project "${CLAUDE_PROJECT_DIR}" $ARGUMENTS`

Commands: `status`, `add <path...>`, `remove <path...>`, `on`, `off`, `clear`. Adding the first path turns focus on automatically.

## If they gave nothing, or described it in words

1. Show the current state: `node "${CLAUDE_PLUGIN_ROOT}/scripts/focus.mjs" --project "${CLAUDE_PROJECT_DIR}" status`
2. If they described what they want ("just chapter 3 and my interview notes"), find the matching paths with Glob, then confirm the exact list in one short sentence before adding.
3. If they said nothing, list the project's top-level folders and likely draft and notes files, then ask which to include with the AskUserQuestion tool (multiSelect). Offer "Turn focus off" as an option when it's on.
4. Run the matching `add`, `remove`, `on` or `off` command.

## Rules

- Never add paths the writer didn't choose, even if a file looks relevant. Suggest it instead.
- When the guard blocks a read, tell the writer which file you wanted and why, and let them decide whether to add it.
- Keep replies short: the resulting list is the answer.
