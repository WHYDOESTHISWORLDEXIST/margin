# Margin

Quiet writing helpers for Claude Code, plus a small VS Code companion.

Margin helps while you write without getting in the way. It never pops up, never edits your draft without asking, and the changes Claude makes with its file tools can be seen and undone. You control it with slash commands and a few questions. There's no CLAUDE.md or config file to edit by hand.

Margin stays out of a project until you run `/margin:setup`, or another `/margin` command that changes something there (`/margin:focus add`, `/margin:check`, `/margin:cite`, `/margin:organize`, or an undo or dismiss in `/margin:review`). Until then its hooks do nothing and create no `.margin/` folder, so it never leaves files behind in a code project you only opened. The one exception is a focus list: once you have set one, it is always enforced.

Margin works in the project folder Claude Code is open in. A project inside a folder where you used Margin before is a Margin project of its own: run `/margin:setup` there. The outer folder's focus list, notes and backups don't apply to it.

| Command | What it does |
| --- | --- |
| `/margin:setup` | A few quick questions: where your drafts, notes and bibliography live, and whether the VS Code companion may quietly offer breaks. `/margin:pause` also reads a story length (`flash`, `short` or `long`) from the same settings |
| `/margin:focus` | Pick exactly which files and folders Claude may read. Reads and searches outside your list are blocked (see [What focus covers](#what-focus-covers)) |
| `/margin:organize` | Proposes a tidy folder layout, moves files only after you approve, and `undo` puts them back |
| `/margin:check` | Checks a draft against your earlier notes for contradictions, missing citations and loose ends, as margin notes. Running it again doesn't repeat notes you already have or dismissed (the same wording, or a reworded note for the same place and source); the same note at several places is kept for each place |
| `/margin:cite` | Checks citation keys against your Zotero (Better BibTeX) library and fixes typos with your OK. Never invents a source. With no draft named, it uses the most recently changed file in your drafts folder and says which |
| `/margin:pause` | A short break whenever you want one: a very short story, a walk, something quiet, or a minute of noticing |
| `/margin:review` | Everything Claude changed with its file tools, with one-step undo (an undo can be undone too), plus your open margin notes |

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

- **Notes wait for a pause.** Notes from `/margin:check` are held until you stop typing for a few seconds, finish a paragraph or switch windows. Then they show as small dots in the gutter: blue for citations, grey for related passages, orange for possible contradictions. Hover a dot to read it. The count in the status bar is the notes that can show as a dot, which means their file exists. Notes match their file whatever the letter case on Windows and macOS.
- **A quiet offer of a break.** After a few minutes of little typing, or mostly deleting, the status bar changes to "Margin · break?". Click it for the break menu, or ignore it. It never pops up. Once you've had it in view for about half a minute, it goes away as soon as you type again or leave the window, and it hides by itself after two minutes. After that it stays away for 20 minutes. It doesn't greet you when you come back from a break, and if you answered no to breaks in `/margin:setup`, it stays off in that project. Choosing "A very short story" copies `/margin:pause story` to your clipboard, ready to paste into Claude Code.
- **Picks up where you left off.** After a walk or quiet break, your last line is briefly highlighted when you come back, if that's within half an hour and you haven't started typing again.

The quiet stretch before the offer is **Margin: Quiet Minutes** (default 3); a value you set under that setting's old name is still honored. Changes to the companion's timing and break settings take effect straight away; no reload is needed. Dismissing a note is written safely alongside Claude's own writes.

To try it before it's published, open the `vscode-extension` folder in VS Code and press F5. That starts a test window with the extension loaded. Settings are under **Settings › Extensions › Margin**.

## How it works

```
your project/
  .margin/                  appears when Margin is set up (see above)
    settings.json           answers from /margin:setup; its presence means "set up"
    focus.json              the files Claude may read
    suggestions.json        margin notes waiting for you
    log.jsonl               every file Claude changed, and every undo
    log.lock                exists only for a moment while the log is written
    history/                a backup taken before each change
      pending/              backups waiting for their edit to finish
    undo.jsonl              a record of undos
    moves.jsonl             organize moves, for undo
    plan.json               the last organize plan
    trash/                  files Claude created and you undid
    errors.jsonl            problems one of Margin's hooks ran into
    *.damaged-<time>        a damaged Margin file, kept aside and never silently replaced
```

- **Focus** is enforced by hooks, not by asking Claude nicely. While focus is on, reading or searching outside your list is blocked, and Claude is told which file it wanted so you can decide.
- **Backups** are taken by a hook just before Claude writes or edits a file with its file tools (Edit, Write, MultiEdit, NotebookEdit), once Margin is set up in the project. `/margin:review undo <n>` restores one. If a backup can't be made, Claude Code asks you before the change goes ahead.
- **Backups younger than 30 days are always kept, and so are the first and the latest backup of each file.** A backup whose log entry is damaged or missing counts as well, by the date of its file. If `.margin/history/` passes 200 MB, the oldest other backups are cleared, oldest first. `/margin:review` still lists those changes and shows "backup cleared" with the date, so you can see what happened even though it can no longer be undone.
- **Undo restores the file as it was before change *n*.** If later changes touched the same file, or you edited it since, undo stops, explains, and asks first. Every undo keeps the version it replaces and is listed as a change of its own, so an undo can be undone too. If the file is open in another program, undo says so and changes nothing; close it and run undo again. `/margin:review` shows times in your own time zone.
- **Margin never deletes your files.** Organize refuses to overwrite, and a file Claude created goes to `.margin/trash` when you undo it. The only thing Margin removes is its own old backup copies, as described above.
- **Margin's own files are changed by its commands.** Claude's file tools can't edit anything in `.margin/` except the organize plan, so Claude doesn't switch focus off or damage the undo log by editing those files. This covers the file tools, not shell commands. Like focus, it keeps Claude from drifting; it isn't a lock against a determined model.
- **A damaged focus list pauses Claude's reading, never its edits,** until you run `/margin:focus status`, which repairs the list and keeps a copy of the damaged one. A damaged notes or settings file is kept aside the same way.
- **Organize** looks at files of any size when it finds identical copies, skips tool folders such as `.git`, `node_modules`, `.venv`, `dist` and `build`, and refuses a folder outside the project. It won't move `.git`, `.margin`, `node_modules` or the project folder. If undo can't put a file back (say, a new file has its name), run undo again once that's sorted out.
- **Citations** use the library you name, else the `bibliography` setting, else the newest `.bib` file in the project, and Margin says which when there are several. A Better BibTeX export works best. pandoc-crossref labels (`@fig:`, `@tbl:`, `@eq:`, `@sec:`, `@lst:`) aren't reported as missing citations unless your library has such a key, and `\Cite`, `\Citep`, `\Citet` and `\Cites` are read like their lower-case forms.

You may want to add `.margin/` to your project's `.gitignore`.

### What focus covers

The focus list covers Claude's Read and Grep tools and the shell commands that read or search files: Bash, and PowerShell on Windows. On Claude Code 2.1.314 or later, commands started with the Monitor tool are checked the same way, according to Claude Code's documentation (not yet confirmed in a live session here). A known reader or search outside the list (`cat`, `head`, `grep -r`, `Get-Content`, `Select-String` and the like) is blocked with the same message as a Read. Commands run through `eval` or PowerShell's `Invoke-Expression`, PowerShell .NET reads such as `[IO.File]::ReadAllText(...)`, and a `cd` inside a subshell are followed too. Anything Margin can't be sure about, such as a one-line script naming an outside file, a file name in a variable or an unknown program, asks you first. A search with no path, or a relative one, means Claude's current folder.

Reads from device files such as `/dev/null` never count, and neither do git commands that don't print file contents (`add`, `commit`, `status`, `checkout`, `mv`, `rm`, `push`, `pull` and so on). `git diff`, `show`, `log`, `grep` and `blame` still ask when they name a file outside the list.

It also covers Margin's own backups in `.margin/history` and `.margin/trash`, since they hold copies of your files. Margin's settings and lists in `.margin/` stay readable, and so do Claude Code's own session files (its scratchpad and saved tool output).

What it doesn't do:

- File and folder names stay visible, for example to Glob and `ls`; only contents are kept out.
- It can't see inside programs that open files by themselves, like a script file, `git log -p` or a build tool.
- It doesn't cover files you `@`-mention yourself (they are added without a tool call, so no hook sees them) or MCP tools.
- It limits reading, not writing: it doesn't stop Claude from creating or editing files. Shell commands that write follow Claude Code's permission mode; for example, in Accept Edits mode `mv` and `cp` run without asking.

### What is backed up

Backups and the change list cover what Claude changes with its file tools. Changes made through shell commands (`sed -i`, redirects, `mv`, `rm`, `Set-Content`) are not backed up or listed in `/margin:review`, and neither is anything you or another program change. Organize moves are logged separately and undone with `/margin:organize undo`.

## Repository layout

```
.claude-plugin/marketplace.json    lets people install from this repo
plugins/margin/                    the Claude Code plugin
  .claude-plugin/plugin.json
  skills/<command>/SKILL.md        one folder per slash command
  hooks/hooks.json                 focus guard, shell guard, backups, change log
  scripts/                         small dependency-free Node scripts
vscode-extension/                  the VS Code companion
examples/sample-project/           a tiny project to try it on
test/run-tests.mjs                 tests for the scripts, the hooks as wired in hooks.json, the skills and the companion
test/vscode-mock.cjs               a stand-in for the VS Code API, so the companion runs in the tests
test/fixtures/                     sample citation files for the tests
```

## Develop

```
node test/run-tests.mjs
```

The tests run each hook command from `hooks.json` through `sh -c`, in a copy of the plugin and a project whose paths contain spaces. That needs a Bash-compatible `sh` on the PATH (Git Bash on Windows); without one, those three tests are skipped with a message.

Claude Code updates an installed plugin only when the `version` in `plugins/margin/.claude-plugin/plugin.json` changes, so raise it with every change people should receive. Otherwise `claude plugin update` reports the plugin as already up to date and keeps the old code.

To load the plugin from this folder without installing it, start Claude Code with:

```
claude --plugin-dir ./plugins/margin
```

Scripts in `plugins/margin/scripts/` can also be run by hand. They take `--project <folder>` to name the project (the skills pass `"${CLAUDE_PROJECT_DIR}"`). For example `node scripts/settings.mjs --project . init` sets Margin up, `node scripts/review.mjs --project . list` shows the changes, and `node scripts/review.mjs --project . undo 3 --go-ahead` goes ahead with an undo that stopped and explained.

## Background

The design follows research on interruptions and creative incubation:

- Interruptions cost less at natural breakpoints ([Iqbal & Bailey](https://www.ideals.illinois.edu/items/11289)).
- Undemanding breaks that let the mind wander help more than demanding ones ([Baird et al., 2012](https://pubmed.ncbi.nlm.nih.gov/22941876/); [Sio & Ormerod, 2009](https://pubmed.ncbi.nlm.nih.gov/19210055/)).
- Walking boosts idea generation ([Oppezzo & Schwartz, 2014](https://www.apa.org/news/press/releases/2014/04/creativity-walk)).

## License

MIT
