# Margin

Quiet writing helpers for Claude Code, plus a small VS Code companion.

Margin helps while you write without getting in the way. It never pops up, never edits your draft without asking, and everything it changes can be seen and undone. You control it with slash commands and a few questions. There's no CLAUDE.md or config file to edit by hand.

| Command | What it does |
| --- | --- |
| `/margin:setup` | A few quick questions: where your drafts, notes and bibliography live, and whether to suggest breaks |
| `/margin:focus` | Pick exactly which files and folders Claude may read. Everything else is blocked |
| `/margin:organize` | Proposes a tidy folder layout, moves files only after you approve, and `undo` puts them back |
| `/margin:check` | Checks a draft against your earlier notes for contradictions, missing citations and loose ends, as margin notes |
| `/margin:cite` | Checks citation keys against your Zotero (Better BibTeX) library and fixes typos with your OK. Never invents a source |
| `/margin:pause` | A short break when you're stuck: a very short story, a walk, something quiet, or a minute of noticing |
| `/margin:review` | Everything Claude changed, with one-step undo, plus your open margin notes |

## Install in Claude Code

From inside Claude Code:

```
/plugin marketplace add WHYDOESTHISWORLDEXIST/margin
/plugin install margin@margin-tools
```

Then open your writing project in Claude Code and run `/margin:setup`.

Requires [Node.js](https://nodejs.org) 18 or newer, which the helper scripts use.

## Install the VS Code companion (optional)

The companion handles the parts Claude Code can't see: your typing rhythm.

- **Notes wait for a pause.** Notes from `/margin:check` are held until you stop typing for a few seconds, finish a paragraph or switch windows. Then they show as small dots in the gutter: blue for citations, grey for related passages, orange for possible contradictions. Hover a dot to read it.
- **A quiet offer of a break.** If you've been mostly deleting, or idle mid-draft, for a few minutes, the status bar changes to "Margin · break?". Click it for the break menu, or ignore it. It never pops up, and it backs off for 20 minutes after you've seen it.
- **Picks up where you left off.** After a walk or quiet break, your last line is briefly highlighted when you come back.

To try it before it's published, open the `vscode-extension` folder in VS Code and press F5. That starts a test window with the extension loaded. Settings are under **Settings › Extensions › Margin**.

## How it works

```
your project/
  .margin/
    settings.json      answers from /margin:setup
    focus.json         the files Claude may read
    suggestions.json   margin notes waiting for you
    log.jsonl          every file Claude changed
    history/           a backup taken before each change
    moves.jsonl        organize batches, for undo
    trash/             files Claude created and you undid
```

- **Focus** is enforced by a hook, not by asking Claude nicely. While focus is on, reading or searching outside your list is blocked, and Claude is told which file it wanted so you can decide.
- **Backups** are taken by a hook just before Claude writes or edits any file. `/margin:review undo <n>` restores one.
- **Nothing is deleted.** Organize refuses to overwrite, and undo moves created files to `.margin/trash`.

You may want to add `.margin/` to your project's `.gitignore`.

### What focus covers

Focus blocks Claude's Read and Grep tools. It doesn't stop shell commands like `cat`, and file names stay visible to Glob. Claude's own permission prompts still apply to shell commands.

## Repository layout

```
.claude-plugin/marketplace.json    lets people install from this repo
plugins/margin/                    the Claude Code plugin
  .claude-plugin/plugin.json
  skills/<command>/SKILL.md        one folder per slash command
  hooks/hooks.json                 focus guard, backups, change log
  scripts/                         small dependency-free Node scripts
vscode-extension/                  the VS Code companion
examples/sample-project/           a tiny project to try it on
test/run-tests.mjs                 tests for the scripts
```

## Develop

```
node test/run-tests.mjs
```

To load the plugin from this folder without installing it, start Claude Code with:

```
claude --plugin-dir ./plugins/margin
```

## Background

The design follows research on interruptions and creative incubation:

- Interruptions cost less at natural breakpoints ([Iqbal & Bailey](https://www.ideals.illinois.edu/items/11289)).
- Undemanding breaks that let the mind wander help more than demanding ones ([Baird et al., 2012](https://pubmed.ncbi.nlm.nih.gov/22941876/); [Sio & Ormerod, 2009](https://pubmed.ncbi.nlm.nih.gov/19210055/)).
- Walking boosts idea generation ([Oppezzo & Schwartz, 2014](https://www.apa.org/news/press/releases/2014/04/creativity-walk)).

## License

MIT
