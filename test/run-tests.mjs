// Runs Margin's scripts against throwaway projects. No dependencies.
// Usage: node test/run-tests.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..', 'plugins', 'margin', 'scripts');
const require = createRequire(import.meta.url);
const { PauseTracker, BreakOffer, endsParagraph } = require('../vscode-extension/pause.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// Throwaway projects live under the temp folder, with a space in the path, and
// are removed when the run ends.
const made = [];
process.on('exit', () => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin test '));
  made.push(dir);
  const files = {
    'drafts/ch3.md': 'The mills closed in 1871 [@smith2020].\nSee also \\cite{jones2019, smtih2020}.\n',
    'notes/interviews.md': 'Mr. Hale said the mills closed in 1874.\n',
    'notes/private.md': 'Not for Claude.\n',
    'sources/library.bib': '@book{smith2020,\n  title = {Tide Mills},\n  author = {Smith, Ann},\n  year = {2020}\n}\n\n@article{jones2019,\n  title = {{Estuary Work}},\n  author = {Jones, B.},\n  year = {2019}\n}\n',
    'old copy.md': 'The mills closed in 1871 [@smith2020].\nSee also \\cite{jones2019, smtih2020}.\n'
  };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

function run(script, args, dir, input, extraEnv = {}) {
  const res = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    cwd: dir,
    input: input ? JSON.stringify(input) : '',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: path.join(scripts, '..'), ...extraEnv },
    encoding: 'utf8'
  });
  return { out: res.stdout, err: res.stderr, code: res.status };
}

function hook(dir, tool, toolInput, id = 'toolu_1', script = 'guard.mjs') {
  return run(script, [], dir, { cwd: dir, tool_name: tool, tool_input: toolInput, tool_use_id: id, hook_event_name: 'PreToolUse' });
}

// What /margin:setup (or any Margin command that changes something) does first.
const setUp = (dir) => run('settings.mjs', ['ensure'], dir);

test('focus off: reads are allowed', () => {
  const dir = project();
  assert(hook(dir, 'Read', { file_path: path.join(dir, 'notes/private.md') }).out === '', 'expected no output');
});

test('focus on: reads outside the list are denied with a helpful reason', () => {
  const dir = project();
  run('focus.mjs', ['add', 'drafts', 'notes/interviews.md'], dir);
  const res = hook(dir, 'Read', { file_path: path.join(dir, 'notes/private.md') });
  const out = JSON.parse(res.out);
  assert(out.hookSpecificOutput.permissionDecision === 'deny', 'expected deny');
  assert(out.hookSpecificOutput.permissionDecisionReason.includes('/margin:focus add notes/private.md'), 'reason should say how to widen');
});

test('focus on: reads inside the list are allowed', () => {
  const dir = project();
  run('focus.mjs', ['add', 'drafts', 'notes/interviews.md'], dir);
  assert(hook(dir, 'Read', { file_path: path.join(dir, 'drafts/ch3.md') }).out === '', 'folder entry should allow');
  assert(hook(dir, 'Read', { file_path: 'notes/interviews.md' }).out === '', 'relative file entry should allow');
});

test('focus on: a whole-project search is denied, a focused one allowed', () => {
  const dir = project();
  run('focus.mjs', ['add', 'drafts'], dir);
  assert(JSON.parse(hook(dir, 'Grep', { pattern: 'mill' }).out).hookSpecificOutput.permissionDecision === 'deny', 'expected deny');
  assert(hook(dir, 'Grep', { pattern: 'mill', path: 'drafts' }).out === '', 'expected allow');
});

test('focus on: Margin’s own folder stays readable', () => {
  const dir = project();
  run('focus.mjs', ['add', 'drafts'], dir);
  assert(hook(dir, 'Read', { file_path: path.join(dir, '.margin/focus.json') }).out === '', 'expected allow');
});

test('focus off keeps the list but stops enforcing it', () => {
  const dir = project();
  run('focus.mjs', ['add', 'drafts'], dir);
  const off = run('focus.mjs', ['off'], dir);
  assert(off.out.includes('OFF') && off.out.includes('drafts'), 'status should show list and OFF');
  assert(hook(dir, 'Read', { file_path: 'notes/private.md' }).out === '', 'expected allow when off');
});

test('focus context is added to prompts only when focus is on', () => {
  const dir = project();
  assert(run('focus-context.mjs', [], dir, { cwd: dir }).out === '', 'expected nothing when off');
  run('focus.mjs', ['add', 'drafts'], dir);
  const ctx = JSON.parse(run('focus-context.mjs', [], dir, { cwd: dir }).out);
  assert(ctx.hookSpecificOutput.additionalContext.includes('drafts'), 'context should list drafts');
});

test('edits are backed up, logged and can be undone', () => {
  const dir = project();
  setUp(dir);
  const file = path.join(dir, 'drafts/ch3.md');
  const before = fs.readFileSync(file, 'utf8');
  hook(dir, 'Edit', { file_path: file }, 'toolu_edit');
  fs.writeFileSync(file, 'changed by Claude\n');
  run('log-change.mjs', [], dir, { cwd: dir, tool_name: 'Edit', tool_input: { file_path: file }, tool_use_id: 'toolu_edit' });
  const list = run('review.mjs', ['list'], dir).out;
  assert(list.includes('edited') && list.includes('drafts/ch3.md'), 'log should list the edit');
  run('review.mjs', ['undo', '1'], dir);
  assert(fs.readFileSync(file, 'utf8') === before, 'undo should restore the original');
});

test('a file Claude created is moved to trash on undo, not deleted', () => {
  const dir = project();
  setUp(dir);
  const file = path.join(dir, 'drafts/new.md');
  hook(dir, 'Write', { file_path: file }, 'toolu_new');
  fs.writeFileSync(file, 'new\n');
  run('log-change.mjs', [], dir, { cwd: dir, tool_name: 'Write', tool_input: { file_path: file }, tool_use_id: 'toolu_new' });
  run('review.mjs', ['undo', '1'], dir);
  assert(!fs.existsSync(file), 'file should be gone from drafts');
  assert(fs.readdirSync(path.join(dir, '.margin/trash')).length === 1, 'file should be in trash');
});

test('citation check finds typos and suggests the close key', () => {
  const dir = project();
  const report = JSON.parse(run('cite-check.mjs', ['drafts/ch3.md'], dir).out);
  assert(report.library === 'sources/library.bib', 'should find the .bib');
  assert(report.citations === 3 && report.resolved === 2, `expected 3 citations, 2 resolved, got ${report.citations}/${report.resolved}`);
  assert(report.unresolved[0].key === 'smtih2020' && report.unresolved[0].closeMatches[0] === 'smith2020', 'should suggest smith2020');
});

test('inventory spots identical files', () => {
  const dir = project();
  const out = run('inventory.mjs', [], dir).out;
  assert(out.includes('Identical files') && out.includes('old copy.md'), 'should list the duplicate');
});

test('organize moves can be applied and undone, never overwriting', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.margin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.margin/plan.json'), JSON.stringify([
    { from: 'old copy.md', to: 'archive/duplicates/old copy.md' },
    { from: 'notes/private.md', to: 'notes/interviews.md' }
  ]));
  const out = run('move.mjs', ['apply', '.margin/plan.json'], dir).out;
  assert(out.includes('already exists'), 'should refuse to overwrite');
  assert(fs.existsSync(path.join(dir, 'archive/duplicates/old copy.md')), 'should move the duplicate');
  run('move.mjs', ['undo'], dir);
  assert(fs.existsSync(path.join(dir, 'old copy.md')), 'undo should put it back');
});

test('margin notes can be queued, listed and dismissed', () => {
  const dir = project();
  run('suggestions.mjs', ['add', JSON.stringify({ file: 'drafts/ch3.md', line: 1, kind: 'contradiction', message: '1871 here, 1874 in notes.' })], dir);
  const data = JSON.parse(fs.readFileSync(path.join(dir, '.margin/suggestions.json'), 'utf8'));
  assert(data.items.length === 1 && data.items[0].kind === 'contradiction', 'note should be stored');
  run('suggestions.mjs', ['dismiss', data.items[0].id], dir);
  assert(run('suggestions.mjs', ['list'], dir).out.includes('No open margin notes'), 'dismissed note should be hidden');
});

test('settings can be set without editing files', () => {
  const dir = project();
  run('settings.mjs', ['set', 'bibliography', 'sources/library.bib'], dir);
  run('settings.mjs', ['set', 'suggestBreaks', 'no'], dir);
  const out = run('settings.mjs', ['show'], dir).out;
  assert(out.includes('bibliography: sources/library.bib') && out.includes('suggestBreaks: false'), 'settings should persist');
});

// --- Damaged or unusual .margin files (A-11/B-11/B-32) ---

const marginPath = (dir, name) => path.join(dir, '.margin', name);
function putMargin(dir, name, text) {
  fs.mkdirSync(path.dirname(marginPath(dir, name)), { recursive: true });
  fs.writeFileSync(marginPath(dir, name), text);
}
function claudeEdits(dir, rel, id, newText, env = {}) {
  const file = path.join(dir, rel);
  hook(dir, 'Edit', { file_path: file }, id);
  fs.writeFileSync(file, newText);
  run('log-change.mjs', [], dir, { cwd: dir, tool_name: 'Edit', tool_input: { file_path: file }, tool_use_id: id, hook_event_name: 'PostToolUse' }, env);
}
const damagedCopies = (dir, name) => fs.readdirSync(path.join(dir, '.margin')).filter((f) => f.startsWith(`${name}.damaged-`));

test('a damaged log line is skipped and the next change is still logged on its own line', () => {
  const dir = project();
  putMargin(dir, 'log.jsonl', '{"time":"2026-11-10T10:00:00.000Z","tool":"Edit","file":"drafts/ch3.md","created":false,"snapshot":null}\n{"time":"2026-11-10T10:01:00.000Z","tool":"Ed');
  setUp(dir);
  claudeEdits(dir, 'drafts/ch3.md', 'toolu_after_damage', 'changed\n');
  const lines = fs.readFileSync(marginPath(dir, 'log.jsonl'), 'utf8').trim().split('\n');
  assert(lines.length === 3 && JSON.parse(lines[2]).tool === 'Edit', 'the new entry should be on a line of its own');
  const list = run('review.mjs', ['list'], dir);
  assert(list.code === 0, `review list should not crash: ${list.err}`);
  assert(list.out.includes('damaged line') && list.out.includes('3\t'), 'list should show the new change as #3 and mention the damaged line');
});

test('undo still works past a damaged log line, and change numbers stay put', () => {
  const dir = project();
  putMargin(dir, 'log.jsonl', '{"time":"2026-11-10T10:01:00.000Z","tool":"Ed\n');
  setUp(dir);
  const file = path.join(dir, 'drafts/ch3.md');
  const before = fs.readFileSync(file, 'utf8');
  claudeEdits(dir, 'drafts/ch3.md', 'toolu_past_damage', 'changed\n');
  const undo = run('review.mjs', ['undo', '2'], dir);
  assert(undo.code === 0 && fs.readFileSync(file, 'utf8') === before, `undo #2 should restore the file: ${undo.out}${undo.err}`);
  assert(fs.readFileSync(marginPath(dir, 'log.jsonl'), 'utf8').startsWith('{"time":"2026-11-10T10:01:00.000Z","tool":"Ed\n'), 'the damaged line should be kept, not dropped');
});

test('undo explains a missing backup in one line', () => {
  const dir = project();
  setUp(dir);
  claudeEdits(dir, 'drafts/ch3.md', 'toolu_missing_backup', 'changed\n');
  for (const f of fs.readdirSync(path.join(dir, '.margin/history'))) if (f.endsWith('.md')) fs.rmSync(path.join(dir, '.margin/history', f));
  const undo = run('review.mjs', ['undo', '1'], dir);
  assert(undo.code === 1 && undo.err === '' && undo.out.trim().split('\n').length === 1 && undo.out.includes('no longer there'), `expected one plain line: ${undo.out}${undo.err}`);
});

test('organize undo skips a damaged record line', () => {
  const dir = project();
  putMargin(dir, 'plan.json', JSON.stringify([{ from: 'old copy.md', to: 'archive/old copy.md' }]));
  run('move.mjs', ['apply', '.margin/plan.json'], dir);
  fs.appendFileSync(marginPath(dir, 'moves.jsonl'), '{"time":"2026');
  const undo = run('move.mjs', ['undo'], dir);
  assert(undo.code === 0 && fs.existsSync(path.join(dir, 'old copy.md')), `undo should put the file back: ${undo.out}${undo.err}`);
  assert(undo.out.includes('damaged line'), 'undo should mention the damaged line');
});

test('a damaged notes file is kept aside, not overwritten', () => {
  const dir = project();
  const damaged = '{"version":1,"items":[{"id":"a1","file":"drafts/ch3.md","line":1,"kind":"todo","message":"one","status":"open"},{"id":"a2"';
  putMargin(dir, 'suggestions.json', damaged);
  const list = run('suggestions.mjs', ['list'], dir);
  assert(list.code === 0 && list.out.includes('damaged') && fs.readFileSync(marginPath(dir, 'suggestions.json'), 'utf8') === damaged, 'list should report the damage and change nothing');
  const add = run('suggestions.mjs', ['add', JSON.stringify({ file: 'drafts/ch3.md', line: 2, message: 'new note' })], dir);
  const kept = damagedCopies(dir, 'suggestions.json');
  assert(kept.length === 1 && fs.readFileSync(marginPath(dir, kept[0]), 'utf8') === damaged, 'the damaged file should be kept as it was');
  assert(add.out.includes(kept[0]), 'add should say where the damaged file went');
  assert(JSON.parse(fs.readFileSync(marginPath(dir, 'suggestions.json'), 'utf8')).items.length === 1, 'the new list should hold the new note');
});

test('notes files of the wrong shape are treated as damaged, not crashed on', () => {
  for (const text of ['{}', '{"items":null}', '[]']) {
    const dir = project();
    putMargin(dir, 'suggestions.json', text);
    const add = run('suggestions.mjs', ['add', JSON.stringify({ file: 'drafts/ch3.md', message: 'x' })], dir);
    assert(add.code === 0 && add.err === '' && damagedCopies(dir, 'suggestions.json').length === 1, `${text}: expected the file kept aside, got ${add.out}${add.err}`);
  }
});

test('a damaged settings file is reported, and kept aside when a setting is saved', () => {
  const dir = project();
  const damaged = '{"drafts":"chapters","bibliography":"refs/zotero.bib"';
  putMargin(dir, 'settings.json', damaged);
  const show = run('settings.mjs', ['show'], dir);
  assert(show.out.includes('damaged') && show.out.includes('drafts: drafts'), 'show should say the file is damaged and show defaults');
  const set = run('settings.mjs', ['set', 'storyLength', 'long'], dir);
  const kept = damagedCopies(dir, 'settings.json');
  assert(kept.length === 1 && fs.readFileSync(marginPath(dir, kept[0]), 'utf8') === damaged, 'the damaged settings should be kept');
  assert(set.out.includes(kept[0]) && run('settings.mjs', ['show'], dir).out.includes('storyLength: long'), 'set should report and save');
});

test('settings of the wrong type are ignored instead of crashing other commands', () => {
  const dir = project();
  putMargin(dir, 'settings.json', JSON.stringify({ bibliography: 7, suggestBreaks: 'maybe', drafts: 'chapters', custom: 'kept' }));
  const show = run('settings.mjs', ['show'], dir);
  assert(show.out.includes('drafts: chapters') && show.out.includes('ignored bibliography') && show.out.includes('ignored suggestBreaks'), `show should name the ignored values: ${show.out}`);
  const cite = run('cite-check.mjs', ['drafts/ch3.md'], dir);
  assert(cite.code === 0 && JSON.parse(cite.out).library === 'sources/library.bib', `cite-check should still find the library: ${cite.err}`);
  run('settings.mjs', ['set', 'notes', 'research'], dir);
  const saved = JSON.parse(fs.readFileSync(marginPath(dir, 'settings.json'), 'utf8'));
  assert(saved.custom === 'kept' && saved.drafts === 'chapters' && saved.notes === 'research', 'unknown keys and valid values should survive a save');
});

test('JSON files that start with a byte-order mark are read normally', () => {
  const dir = project();
  putMargin(dir, 'settings.json', '﻿' + JSON.stringify({ drafts: 'chapters' }));
  putMargin(dir, 'suggestions.json', '﻿' + JSON.stringify({ version: 1, items: [{ id: 'b0', file: 'drafts/ch3.md', line: 1, kind: 'todo', message: 'bom note', status: 'open' }] }));
  assert(run('settings.mjs', ['show'], dir).out.includes('drafts: chapters'), 'settings with a BOM should be read');
  assert(run('suggestions.mjs', ['list'], dir).out.includes('bom note'), 'notes with a BOM should be read');
});

test('Margin rewrites its files without leaving temp files behind', () => {
  const dir = project();
  run('suggestions.mjs', ['add', JSON.stringify({ file: 'drafts/ch3.md', message: 'x' })], dir);
  run('settings.mjs', ['set', 'notes', 'research'], dir);
  assert(!fs.readdirSync(path.join(dir, '.margin')).some((f) => f.endsWith('.tmp')), 'no .tmp files should remain');
});

// --- Which folder is the project (A-03/B-07) ---

// Runs a script the way Claude's shell tool does: CLAUDE_PROJECT_DIR isn't set.
function shellRun(script, args, cwd) {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: path.join(scripts, '..') };
  delete env.CLAUDE_PROJECT_DIR;
  const res = spawnSync(process.execPath, [path.join(scripts, script), ...args], { cwd, env, encoding: 'utf8' });
  return { out: res.stdout, err: res.stderr, code: res.status };
}
function hookWithProjectDir(projectDirValue, cwd, tool, toolInput, id = 'toolu_pd') {
  const res = spawnSync(process.execPath, [path.join(scripts, 'guard.mjs')], {
    cwd,
    input: JSON.stringify({ cwd, tool_name: tool, tool_input: toolInput, tool_use_id: id, hook_event_name: 'PreToolUse' }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDirValue, CLAUDE_PLUGIN_ROOT: path.join(scripts, '..') },
    encoding: 'utf8'
  });
  return { out: res.stdout, err: res.stderr, code: res.status };
}
const marginDirsIn = (dir) => {
  const found = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) { if (e.name === '.margin') found.push(path.relative(dir, d) || '.'); else walk(path.join(d, e.name)); } })(dir);
  return found;
};

test('skill scripts run from a subfolder use the project folder passed with --project', () => {
  const dir = project();
  const out = shellRun('focus.mjs', ['--project', dir, 'add', 'drafts/ch3.md'], path.join(dir, 'drafts'));
  assert(out.out.includes('Focus is ON'), `focus add should work: ${out.out}${out.err}`);
  assert(marginDirsIn(dir).join() === '.', `.margin should exist only at the project root, found: ${marginDirsIn(dir)}`);
  assert(JSON.parse(hook(dir, 'Read', { file_path: path.join(dir, 'notes/private.md') }).out).hookSpecificOutput.permissionDecision === 'deny', 'the guard should enforce it');
});

test('without --project, scripts use the nearest .margin above the current folder', () => {
  const dir = project();
  run('settings.mjs', ['set', 'notes', 'research'], dir);
  const show = shellRun('settings.mjs', ['show'], path.join(dir, 'drafts'));
  assert(show.out.includes('notes: research') && marginDirsIn(dir).join() === '.', `expected the root settings: ${show.out}`);
});

test('a --project value that was never filled in is ignored', () => {
  const dir = project();
  run('settings.mjs', ['set', 'notes', 'research'], dir);
  for (const unfilled of ['${CLAUDE_PROJECT_DIR}', '', '$CLAUDE_PROJECT_DIR', '%CLAUDE_PROJECT_DIR%']) {
    const show = shellRun('settings.mjs', ['--project', unfilled, 'show'], path.join(dir, 'drafts'));
    assert(show.out.includes('notes: research'), `--project "${unfilled}" should be ignored: ${show.out}${show.err}`);
  }
  assert(marginDirsIn(dir).join() === '.', 'no new .margin should appear');
});

test('a project folder Claude Code names is the project, even inside a folder with its own .margin (A2-01)', () => {
  const dir = project();
  run('focus.mjs', ['add', 'notes/interviews.md'], dir);   // the parent's list leaves drafts/ out
  // A session whose project is the subfolder drafts/ is its own project, as the companion sees it.
  const res = hookWithProjectDir(path.join(dir, 'drafts'), path.join(dir, 'drafts'), 'Read', { file_path: path.join(dir, 'drafts', 'ch3.md') });
  assert(res.code === 0 && res.out === '', `the parent's focus list should not apply: ${res.out}${res.err}`);
  assert(marginDirsIn(dir).join() === '.', 'a hook must not create a .margin in the subfolder');
});

test('a project opened inside a folder where Margin was used gets its own .margin (A2-01)', () => {
  const writing = project();
  run('settings.mjs', ['init'], writing);
  fs.mkdirSync(path.join(writing, 'essays'));
  run('focus.mjs', ['add', 'essays'], writing);
  const novel = path.join(writing, 'Novel');
  fs.mkdirSync(path.join(novel, 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(novel, 'drafts', 'ch3.md'), 'The mills closed in 1871 [@smtih2020].\n');
  fs.copyFileSync(path.join(writing, 'sources', 'library.bib'), path.join(novel, 'library.bib'));
  // As the skills run them in Novel: --project names Novel, CLAUDE_PROJECT_DIR isn't set.
  const skill = (script, args) => shellRun(script, ['--project', novel, ...args], novel);
  const setup = skill('settings.mjs', ['init']);
  assert(setup.out.includes(novel) && fs.existsSync(path.join(novel, '.margin', 'settings.json')), `setup should set Novel up: ${setup.out}`);
  assert(skill('focus.mjs', ['add', 'drafts']).out.includes('- drafts'), 'paths are relative to Novel');
  const read = hookWithProjectDir(novel, novel, 'Read', { file_path: path.join(novel, 'drafts', 'ch3.md') });
  assert(read.out === '', `Novel's own focus list applies, not the parent's: ${read.out}`);
  skill('suggestions.mjs', ['add', '--file', 'drafts/ch3.md', '--line', '1', '--kind', 'todo', '--message', 'Check the year.']);
  assert(JSON.parse(fs.readFileSync(path.join(novel, '.margin', 'suggestions.json'), 'utf8')).items[0].file === 'drafts/ch3.md', 'the note is in Novel, where the companion looks');
  assert(!fs.existsSync(path.join(writing, '.margin', 'suggestions.json')), 'nothing is filed in the parent');
  const cite = skill('cite-check.mjs', ['drafts/ch3.md']);
  assert(cite.code === 0 && JSON.parse(cite.out).unresolved[0].key === 'smtih2020', `cite-check reads Novel's draft: ${cite.out}${cite.err}`);
});

test('with no .margin anywhere, a new one goes at the folder with .git, else the current folder', () => {
  const withGit = project();
  fs.mkdirSync(path.join(withGit, '.git'));
  shellRun('focus.mjs', ['add', 'drafts/ch3.md'], path.join(withGit, 'drafts'));
  assert(marginDirsIn(withGit).join() === '.', `expected .margin at the git root, found ${marginDirsIn(withGit)}`);
  const plain = project();
  shellRun('focus.mjs', ['add', 'ch3.md'], path.join(plain, 'drafts'));
  assert(marginDirsIn(plain).join() === 'drafts', `expected .margin in the current folder, found ${marginDirsIn(plain)}`);
});

test('every skill command passes the project folder', () => {
  const skills = path.join(scripts, '..', 'skills');
  for (const name of fs.readdirSync(skills)) {
    const text = fs.readFileSync(path.join(skills, name, 'SKILL.md'), 'utf8');
    for (const m of text.matchAll(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[\w-]+\.mjs"([^`\n]*)/g)) {
      assert(m[1].startsWith(' --project "${CLAUDE_PROJECT_DIR}"'), `${name}/SKILL.md: ${m[0]}`);
    }
  }
});

// --- Hooks stay out of projects where Margin isn't set up (A-05/B-01, K1) ---

function runHookEvent(dir, script, payload) {
  return run(script, [], dir, { cwd: dir, tool_use_id: 'toolu_k1', ...payload });
}

test('hooks do nothing and create nothing in a project where Margin isn\'t set up', () => {
  const dir = project();
  const file = path.join(dir, 'drafts/ch3.md');
  const outs = [
    runHookEvent(dir, 'guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file } }),
    runHookEvent(dir, 'guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'mill' } }),
    runHookEvent(dir, 'guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file } }),
    runHookEvent(dir, 'log-change.mjs', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file } }),
    runHookEvent(dir, 'guard.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'new.md') }, tool_use_id: 'toolu_k1w' }),
    runHookEvent(dir, 'focus-context.mjs', { hook_event_name: 'UserPromptSubmit', prompt: 'hello' })
  ];
  assert(outs.every((o) => o.out === '' && o.code === 0), `hooks should be silent: ${JSON.stringify(outs.map((o) => o.out + o.err))}`);
  assert(!fs.existsSync(path.join(dir, '.margin')), '.margin should not be created');
});

test('a focus list is enforced even before /margin:setup, without starting backups', () => {
  const dir = project();
  run('focus.mjs', ['add', 'drafts'], dir);
  assert(!fs.existsSync(marginPath(dir, 'settings.json')), 'focus alone should not set Margin up');
  assert(JSON.parse(hook(dir, 'Read', { file_path: path.join(dir, 'notes/private.md') }).out).hookSpecificOutput.permissionDecision === 'deny', 'focus should be enforced');
  claudeEdits(dir, 'drafts/ch3.md', 'toolu_focus_only', 'changed\n');
  assert(!fs.existsSync(marginPath(dir, 'history')) && !fs.existsSync(marginPath(dir, 'log.jsonl')), 'no backup or log before setup');
});

test('edits are backed up once Margin is set up', () => {
  const dir = project();
  setUp(dir);
  claudeEdits(dir, 'drafts/ch3.md', 'toolu_after_setup', 'changed\n');
  assert(fs.readdirSync(marginPath(dir, 'history')).some((f) => f.endsWith('.md')) && fs.existsSync(marginPath(dir, 'log.jsonl')), 'backup and log expected');
});

test('settings ensure sets Margin up once and stays quiet afterwards; init keeps answers', () => {
  const dir = project();
  const first = run('settings.mjs', ['ensure'], dir);
  assert(first.out.includes('set up in') && fs.existsSync(marginPath(dir, 'settings.json')), `first ensure should set up: ${first.out}`);
  assert(run('settings.mjs', ['ensure'], dir).out === '', 'second ensure should print nothing');
  run('settings.mjs', ['set', 'notes', 'research'], dir);
  const init = run('settings.mjs', ['init'], dir);
  assert(init.out.includes('set up in') && run('settings.mjs', ['show'], dir).out.includes('notes: research'), 'init should keep earlier answers and say where');
});

test('skills set Margin up before they change anything', () => {
  const skills = path.join(scripts, '..', 'skills');
  const read = (name) => fs.readFileSync(path.join(skills, name, 'SKILL.md'), 'utf8');
  const ensure = 'settings.mjs" --project "${CLAUDE_PROJECT_DIR}" ensure';
  for (const name of ['check', 'cite', 'focus', 'organize', 'review']) assert(read(name).includes(ensure), `${name} should run settings ensure`);
  assert(read('setup').includes('settings.mjs" --project "${CLAUDE_PROJECT_DIR}" init'), 'setup should run settings init');
});

// --- A damaged focus list never fails open silently (A-06/B-02) ---

const decisionOf = (res) => (res.out.trim() ? JSON.parse(res.out).hookSpecificOutput.permissionDecision : 'allow');
const reasonOf = (res) => (res.out.trim() ? JSON.parse(res.out).hookSpecificOutput.permissionDecisionReason : '');

test('a damaged focus list pauses reads, never edits, and says how to repair it', () => {
  const variants = ['{"enabled": true, "paths": ["dra', '', 'null', '{"enabled": "false", "paths": ["drafts"]}', '{"enabled": true, "paths": "drafts"}', '[]'];
  for (const text of variants) {
    const dir = project();
    putMargin(dir, 'focus.json', text);
    for (const target of ['notes/private.md', 'drafts/ch3.md']) {
      const res = hook(dir, 'Read', { file_path: path.join(dir, target) });
      assert(res.code === 0 && decisionOf(res) === 'deny' && reasonOf(res).includes('/margin:focus status'), `${JSON.stringify(text)} ${target}: ${res.out}${res.err}`);
    }
    assert(decisionOf(hook(dir, 'Grep', { pattern: 'mill', path: 'drafts' })) === 'deny', `${JSON.stringify(text)}: Grep should be paused too`);
    const edit = hook(dir, 'Edit', { file_path: path.join(dir, 'drafts/ch3.md') });
    assert(edit.code === 0 && edit.out === '', `${JSON.stringify(text)}: edits must never be blocked`);
  }
});

test('a focus file that starts with a byte-order mark is read normally', () => {
  const dir = project();
  putMargin(dir, 'focus.json', '﻿' + JSON.stringify({ enabled: true, paths: ['drafts'] }));
  assert(decisionOf(hook(dir, 'Read', { file_path: path.join(dir, 'drafts/ch3.md') })) === 'allow', 'listed file should be readable');
  const outside = hook(dir, 'Read', { file_path: path.join(dir, 'notes/private.md') });
  assert(decisionOf(outside) === 'deny' && reasonOf(outside).includes("isn't in it"), 'outside file should get the normal focus reason');
});

test('focus entries that aren\'t file names are ignored without crashing the guard', () => {
  const dir = project();
  putMargin(dir, 'focus.json', JSON.stringify({ enabled: true, paths: ['drafts', 7, null, ''] }));
  const inside = hook(dir, 'Read', { file_path: path.join(dir, 'drafts/ch3.md') });
  const outside = hook(dir, 'Read', { file_path: path.join(dir, 'notes/private.md') });
  assert(inside.code === 0 && decisionOf(inside) === 'allow' && decisionOf(outside) === 'deny', `${inside.err}${outside.err}`);
  const ctx = JSON.parse(run('focus-context.mjs', [], dir, { cwd: dir }).out).hookSpecificOutput.additionalContext;
  assert(ctx.includes('drafts') && ctx.includes('ignored'), `context should mention the ignored entries: ${ctx}`);
});

test('focus context tells Claude when the focus list is damaged', () => {
  const dir = project();
  putMargin(dir, 'focus.json', '{"enabled": tr');
  const ctx = JSON.parse(run('focus-context.mjs', [], dir, { cwd: dir }).out).hookSpecificOutput.additionalContext;
  assert(ctx.includes('damaged') && ctx.includes('/margin:focus status'), ctx);
});

test('focus status repairs a damaged list and keeps a copy of it', () => {
  const dir = project();
  const damaged = '{"enabled": true, "paths": ["drafts", "notes/interviews.md", "sour';
  putMargin(dir, 'focus.json', damaged);
  const status = run('focus.mjs', ['status'], dir);
  const kept = damagedCopies(dir, 'focus.json');
  assert(kept.length === 1 && fs.readFileSync(marginPath(dir, kept[0]), 'utf8') === damaged, 'the damaged list should be kept');
  assert(status.out.includes('damaged') && status.out.includes(kept[0]), `status should report the repair: ${status.out}`);
  const repaired = JSON.parse(fs.readFileSync(marginPath(dir, 'focus.json'), 'utf8'));
  assert(repaired.enabled === true && repaired.paths.join() === 'drafts,notes/interviews.md', `salvaged list: ${JSON.stringify(repaired)}`);
  assert(decisionOf(hook(dir, 'Read', { file_path: path.join(dir, 'drafts/ch3.md') })) === 'allow', 'reads in the list work again');
});

test('if the guard itself fails, reads are paused with a message and edits go ahead', () => {
  const dir = project();
  setUp(dir);
  run('focus.mjs', ['add', 'drafts'], dir);
  const fail = { MARGIN_TEST_FAIL: 'guard' };
  const read = run('guard.mjs', [], dir, { cwd: dir, tool_name: 'Read', tool_input: { file_path: path.join(dir, 'drafts/ch3.md') }, tool_use_id: 'toolu_f1', hook_event_name: 'PreToolUse' }, fail);
  assert(read.code === 0 && decisionOf(read) === 'deny' && reasonOf(read).includes('unexpected problem'), `${read.out}${read.err}`);
  const edit = run('guard.mjs', [], dir, { cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'drafts/ch3.md') }, tool_use_id: 'toolu_f2', hook_event_name: 'PreToolUse' }, fail);
  assert(edit.code === 0 && edit.out === '', 'an edit must not be blocked');
  assert(fs.readFileSync(marginPath(dir, 'errors.jsonl'), 'utf8').includes('simulated failure'), 'the failure should be recorded');
});

// --- Undo never destroys anything and asks before rolling back more (A-01+A-02/B-03, K3; A-25/B-24) ---

const readText = (file) => fs.readFileSync(file, 'utf8');
function threeClaudeEdits(dir) {
  const file = path.join(dir, 'drafts/ch3.md');
  fs.writeFileSync(file, 'v0\n');
  claudeEdits(dir, 'drafts/ch3.md', 'toolu_v1', 'v1\n');
  claudeEdits(dir, 'drafts/ch3.md', 'toolu_v2', 'v2\n');
  claudeEdits(dir, 'drafts/ch3.md', 'toolu_v3', 'v3\n');
  return file;
}
const historyHolding = (dir, text) => fs.readdirSync(marginPath(dir, 'history')).some((f) => {
  const p = marginPath(dir, path.join('history', f));
  return fs.statSync(p).isFile() && readText(p).includes(text);
});

test('undo refuses when later changes touched the same file, and changes nothing', () => {
  const dir = project();
  setUp(dir);
  const file = threeClaudeEdits(dir);
  const res = run('review.mjs', ['undo', '1'], dir);
  assert(res.code === 2 && res.out.includes('#2, #3') && res.out.includes('undo 1 --go-ahead') && res.out.includes('undo 3'), `expected a refusal: ${res.out}${res.err}`);
  assert(readText(file) === 'v3\n', 'the file must not change');
});

test('undoing the latest change first, then the earlier ones, restores the original', () => {
  const dir = project();
  setUp(dir);
  const file = threeClaudeEdits(dir);
  for (const [n, expected] of [['3', 'v2\n'], ['2', 'v1\n'], ['1', 'v0\n']]) {
    const res = run('review.mjs', ['undo', n], dir);
    assert(res.code === 0 && readText(file) === expected, `undo ${n}: ${res.out}${res.err}`);
  }
});

test('undo --go-ahead rolls later changes back too, and the list stays truthful', () => {
  const dir = project();
  setUp(dir);
  const file = threeClaudeEdits(dir);
  const res = run('review.mjs', ['undo', '1', '--go-ahead'], dir);
  assert(res.code === 0 && readText(file) === 'v0\n' && res.out.includes('#2, #3'), `${res.out}${res.err}`);
  const list = run('review.mjs', ['list'], dir).out;
  assert(/^4\t.*\tundid #1, #2, #3\tdrafts\/ch3\.md\tyes$/m.test(list), `the undo should be listed: ${list}`);
  for (const n of ['1', '2', '3']) assert(new RegExp(`^${n}\\t.*\\tundone\\t.*\\tno$`, 'm').test(list), `#${n} should show as undone: ${list}`);
  assert(run('review.mjs', ['undo', '2'], dir).out.includes('already undone'), 'a rolled-back change is not offered again');
});

test('undo refuses when the file changed since Claude\'s change', () => {
  const dir = project();
  setUp(dir);
  const file = path.join(dir, 'drafts/ch3.md');
  claudeEdits(dir, 'drafts/ch3.md', 'toolu_c1', 'Claude tightened this.\n');
  fs.appendFileSync(file, 'Two hours of the writer\'s own prose.\n');
  const res = run('review.mjs', ['undo', '1'], dir);
  assert(res.code === 2 && res.out.includes('changed since') && readText(file).includes('Two hours'), `${res.out}${res.err}`);
});

test('a forced undo keeps the writer\'s text, and the undo can itself be undone', () => {
  const dir = project();
  setUp(dir);
  const file = path.join(dir, 'drafts/ch3.md');
  fs.writeFileSync(file, 'Opening.\n');
  claudeEdits(dir, 'drafts/ch3.md', 'toolu_c2', 'A better opening.\n');
  fs.appendFileSync(file, 'Two hours of the writer\'s own prose.\n');
  const res = run('review.mjs', ['undo', '1', '--go-ahead'], dir);
  assert(res.code === 0 && readText(file) === 'Opening.\n' && res.out.includes('undo 2'), `${res.out}${res.err}`);
  assert(historyHolding(dir, 'Two hours'), 'the writer\'s version should be kept in history');
  const back = run('review.mjs', ['undo', '2'], dir);
  assert(back.code === 0 && readText(file) === 'A better opening.\nTwo hours of the writer\'s own prose.\n', `undoing the undo should bring it back: ${back.out}${back.err}`);
  assert(/^1\t.*\tedited\t/m.test(run('review.mjs', ['list'], dir).out), 'change #1 is back in effect');
});

test('a created file the writer edited since: undo refuses, going ahead moves it to the trash', () => {
  const dir = project();
  setUp(dir);
  const file = path.join(dir, 'drafts/new.md');
  hook(dir, 'Write', { file_path: file }, 'toolu_created');
  fs.writeFileSync(file, 'new\n');
  run('log-change.mjs', [], dir, { cwd: dir, tool_name: 'Write', tool_input: { file_path: file }, tool_use_id: 'toolu_created' });
  fs.appendFileSync(file, 'the writer added this\n');
  assert(run('review.mjs', ['undo', '1'], dir).code === 2, 'expected a refusal');
  const res = run('review.mjs', ['undo', '1', '--go-ahead'], dir);
  const trash = fs.readdirSync(marginPath(dir, 'trash'));
  assert(res.code === 0 && !fs.existsSync(file) && trash.length === 1 && readText(marginPath(dir, path.join('trash', trash[0]))).includes('the writer added this'), `${res.out}${res.err}`);
});

test('older log entries without ids or fingerprints still undo, keeping a copy first', () => {
  const dir = project();
  setUp(dir);
  const file = path.join(dir, 'drafts/ch3.md');
  putMargin(dir, 'history/2026-01-01T00-00-00-000Z__drafts__ch3.md', 'original\n');
  putMargin(dir, 'log.jsonl', JSON.stringify({ time: '2026-01-01T00:00:01.000Z', tool: 'Edit', file: 'drafts/ch3.md', created: false, snapshot: '.margin/history/2026-01-01T00-00-00-000Z__drafts__ch3.md' }) + '\n');
  fs.writeFileSync(file, 'current\n');
  const res = run('review.mjs', ['undo', '1'], dir);
  assert(res.code === 0 && readText(file) === 'original\n' && historyHolding(dir, 'current'), `${res.out}${res.err}`);
  const lines = readText(marginPath(dir, 'log.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
  assert(lines[0].id === 1 && lines[0].undone && lines[1].id === 2 && lines[1].tool === 'undo', JSON.stringify(lines));
});

test('/margin:review lists changes in local time', () => {
  const dir = project();
  setUp(dir);
  putMargin(dir, 'log.jsonl', JSON.stringify({ id: 1, time: '2026-11-10T16:40:00.000Z', tool: 'Edit', file: 'drafts/ch3.md', created: false, snapshot: null }) + '\n');
  const out = run('review.mjs', ['list'], dir, null, { TZ: 'Asia/Tokyo' }).out;
  assert(out.includes('2026-11-11 01:40'), `expected Tokyo time: ${out}`);
});

async function logAtTheSameMoment(dir, count) {
  const children = [];
  for (let i = 0; i < count; i++) {
    const file = path.join(dir, `drafts/c${i}.md`);
    fs.writeFileSync(file, `c${i}\n`);
    children.push(new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(scripts, 'log-change.mjs')], { cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: path.join(scripts, '..') } });
      child.on('close', resolve);
      child.stdin.end(JSON.stringify({ cwd: dir, tool_name: 'Write', tool_input: { file_path: file }, tool_use_id: `toolu_same${i}`, hook_event_name: 'PostToolUse' }));
    }));
  }
  await Promise.all(children);
}
const sameMoment = project();
setUp(sameMoment);
await logAtTheSameMoment(sameMoment, 8);
test('changes logged at the same moment get different numbers', () => {
  const ids = readText(marginPath(sameMoment, 'log.jsonl')).trim().split('\n').map((l) => JSON.parse(l).id);
  assert(ids.length === 8 && new Set(ids).size === 8 && Math.max(...ids) === 8, `ids: ${ids}`);
});

// --- Backups are capped without hiding anything (A-12/B-13, K2) ---

const backupFiles = (dir) => fs.readdirSync(marginPath(dir, 'history'), { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
const logEntries = (dir) => readText(marginPath(dir, 'log.jsonl')).trim().split('\n').map((l) => JSON.parse(l));

test('over the cap, old backups are cleared but the earliest and newest of each file stay', () => {
  const dir = project();
  setUp(dir);
  const text = (n) => `version ${n} `.repeat(100) + '\n';                // about 1 KB each
  const tight = { MARGIN_TEST_HISTORY_CAP: String(3.5 * text(0).length), MARGIN_TEST_HISTORY_DAYS: '0', MARGIN_TEST_PRUNE_EVERY: '1' };
  fs.writeFileSync(path.join(dir, 'drafts/ch3.md'), text(0));
  for (let n = 1; n <= 6; n++) claudeEdits(dir, 'drafts/ch3.md', `toolu_cap${n}`, text(n), tight);
  const entries = logEntries(dir);
  const kept = entries.filter((e) => e.snapshot).map((e) => e.id);
  assert(kept.join() === '1,5,6', `expected backups of #1 (earliest), #5 and #6 (newest) to stay, got ${kept}`);
  assert(backupFiles(dir).length === 3, `history should hold 3 backups: ${backupFiles(dir)}`);
  assert(entries.filter((e) => e.pruned).map((e) => e.id).join() === '2,3,4', 'cleared changes keep their line, marked pruned');
  const list = run('review.mjs', ['list'], dir).out;
  assert(/^2\t.*\tbackup cleared \d{4}-\d\d-\d\d$/m.test(list), `list should say the backup was cleared: ${list}`);
  const undo = run('review.mjs', ['undo', '2', '--go-ahead'], dir);
  assert(undo.code === 1 && undo.out.includes('was cleared on'), `undo should explain: ${undo.out}${undo.err}`);
});

test('backups younger than 30 days are never cleared, even over the cap', () => {
  const dir = project();
  setUp(dir);
  const tiny = { MARGIN_TEST_HISTORY_CAP: '10', MARGIN_TEST_PRUNE_EVERY: '1' };
  for (let n = 1; n <= 4; n++) claudeEdits(dir, 'drafts/ch3.md', `toolu_young${n}`, `young ${n}\n`, tiny);
  assert(logEntries(dir).every((e) => e.snapshot && !e.pruned) && backupFiles(dir).length === 4, 'all recent backups should stay');
});

test('a young backup is kept even when its log line is damaged or the log is gone (B2-06)', () => {
  const tiny = { MARGIN_TEST_HISTORY_CAP: '10', MARGIN_TEST_PRUNE_EVERY: '1' };
  const makeProject = (label) => {
    const dir = project();
    setUp(dir);
    for (let n = 1; n <= 4; n++) claudeEdits(dir, 'drafts/ch3.md', `toolu_${label}${n}`, `${label} ${n}\n`, tiny);
    return dir;
  };
  // One log line is unreadable: its backup is not mentioned in the log, but it is young.
  const damaged = makeProject('dmg');
  const before = backupFiles(damaged).length;
  const lines = readText(marginPath(damaged, 'log.jsonl')).trim().split('\n');
  lines[1] = lines[1].slice(0, 30);
  fs.writeFileSync(marginPath(damaged, 'log.jsonl'), lines.join('\n') + '\n');
  claudeEdits(damaged, 'drafts/ch3.md', 'toolu_dmg5', 'dmg 5\n', tiny);
  assert(backupFiles(damaged).length === before + 1, `no young backup should be cleared: ${before} before, ${backupFiles(damaged).length} after one more edit`);
  // The log is gone altogether.
  const gone = makeProject('gone');
  const count = backupFiles(gone).length;
  fs.rmSync(marginPath(gone, 'log.jsonl'));
  claudeEdits(gone, 'drafts/ch3.md', 'toolu_gone5', 'gone 5\n', tiny);
  assert(backupFiles(gone).length === count + 1, `no young backup should be cleared without a log: ${count} before, ${backupFiles(gone).length} after`);
  // An old backup nobody mentions can still go when the folder is over the cap.
  const old = makeProject('old');
  const oldCount = backupFiles(old).length;
  fs.rmSync(marginPath(old, 'log.jsonl'));
  const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  for (const name of backupFiles(old)) fs.utimesSync(marginPath(old, `history/${name}`), longAgo, longAgo);
  claudeEdits(old, 'drafts/ch3.md', 'toolu_old5', 'old 5\n', tiny);
  assert(backupFiles(old).length < oldCount + 1, `old unreferenced backups should be cleared over the cap: ${oldCount} before, ${backupFiles(old).length} after`);
});

test('undo with no .margin folder says so in one line and creates nothing (B2-07)', () => {
  const dir = project();
  const res = run('review.mjs', ['undo', '1'], dir);
  assert(res.code === 1 && res.out.trim() === 'Claude has not changed any files yet.' && res.err === '', `${res.out}${res.err}`);
  assert(!fs.existsSync(path.join(dir, '.margin')), 'nothing should be created');
});

test('cite-check with a draft that does not exist says so in one line (B2-07)', () => {
  const dir = project();
  const res = run('cite-check.mjs', ['drafts/nope.md'], dir);
  assert(res.code === 1 && res.out.trim() === 'There is no draft named "drafts/nope.md" in this project.' && res.err === '', `${res.out}${res.err}`);
});

test('a failed or refused edit leaves no backup or pending record behind', () => {
  for (const event of ['PostToolUseFailure', 'PermissionDenied']) {
    const dir = project();
    setUp(dir);
    const file = path.join(dir, 'drafts/ch3.md');
    hook(dir, 'Edit', { file_path: file }, 'toolu_failed');
    assert(backupFiles(dir).length === 1 && fs.existsSync(marginPath(dir, 'history/pending/toolu_failed.json')), 'the guard should have made a backup');
    run('log-change.mjs', [], dir, { cwd: dir, hook_event_name: event, tool_name: 'Edit', tool_input: { file_path: file }, tool_use_id: 'toolu_failed', error: 'old_string not found' });
    assert(backupFiles(dir).length === 0 && !fs.existsSync(marginPath(dir, 'history/pending/toolu_failed.json')), `${event}: backup and pending record should be gone`);
    assert(!fs.existsSync(marginPath(dir, 'log.jsonl')), `${event}: nothing should be logged`);
  }
  const hooks = JSON.parse(fs.readFileSync(path.join(scripts, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  for (const event of ['PostToolUseFailure', 'PermissionDenied']) {
    assert(hooks[event] && hooks[event][0].matcher.includes('Edit') && hooks[event][0].hooks[0].command.includes('log-change.mjs'), `${event} should run log-change.mjs`);
  }
});

test('a pending record older than a day is swept with its backup; newer ones stay', () => {
  const dir = project();
  setUp(dir);
  hook(dir, 'Edit', { file_path: path.join(dir, 'drafts/ch3.md') }, 'toolu_declined');   // a prompt the writer declined: no event follows
  hook(dir, 'Edit', { file_path: path.join(dir, 'notes/interviews.md') }, 'toolu_inflight'); // still waiting for an answer
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(marginPath(dir, 'history/pending/toolu_declined.json'), old, old);
  claudeEdits(dir, 'drafts/ch3.md', 'toolu_next', 'changed\n', { MARGIN_TEST_PRUNE_EVERY: '1' });
  const pending = fs.readdirSync(marginPath(dir, 'history/pending'));
  assert(pending.join() === 'toolu_inflight.json', `only the recent pending record should remain: ${pending}`);
  assert(backupFiles(dir).length === 2, `the declined edit's backup should be gone: ${backupFiles(dir)}`);
});

// --- A2-09: one odd log line, or a draft held open by another program, never ends in a stack trace ---

test('a log line that names no file is skipped as damaged; list and undo still work (A2-09)', () => {
  const dir = project();
  setUp(dir);
  const file = path.join(dir, 'drafts', 'ch3.md');
  const before = readText(file);
  claudeEdits(dir, 'drafts/ch3.md', 'toolu_shape', 'changed\n');
  fs.appendFileSync(marginPath(dir, 'log.jsonl'), JSON.stringify({ id: 2, time: new Date().toISOString(), tool: 'Edit' }) + '\n');
  const list = run('review.mjs', ['list'], dir);
  assert(list.code === 0 && list.err === '' && /^1\t/m.test(list.out) && list.out.includes('damaged line') && list.out.includes('line 2'), `${list.out}${list.err}`);
  const undo = run('review.mjs', ['undo', '1'], dir);
  assert(undo.code === 0 && readText(file) === before, `${undo.out}${undo.err}`);
  assert(readText(marginPath(dir, 'log.jsonl')).includes('{"id":2,'), 'the odd line is kept as it was');
});

test('undo of a file another program holds open says so in one line and changes nothing (A2-09)', () => {
  const dir = project();
  setUp(dir);
  const file = path.join(dir, 'drafts', 'ch3.md');
  claudeEdits(dir, 'drafts/ch3.md', 'toolu_held', 'v1 by Claude\n');
  const backups = backupFiles(dir).length;
  const log = readText(marginPath(dir, 'log.jsonl'));
  const undo = run('review.mjs', ['undo', '1'], dir, null, { MARGIN_TEST_FAIL: 'restore' });
  assert(undo.code === 1 && undo.err === '' && undo.out.trim().split('\n').length === 1 && undo.out.includes('open in another program'), `${undo.out}${undo.err}`);
  assert(readText(file) === 'v1 by Claude\n' && readText(marginPath(dir, 'log.jsonl')) === log, 'the file and the log are unchanged');
  assert(backupFiles(dir).length === backups, 'no copy is left behind');
});

// --- Organize never loses track of a move (A-07/B-10) ---

function plan(dir, steps) {
  putMargin(dir, 'plan.json', JSON.stringify(steps));
  return run('move.mjs', ['apply', '.margin/plan.json'], dir);
}

test('organize records the moves made before a step fails, so undo puts them back', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'a.md'), 'a\n');
  fs.writeFileSync(path.join(dir, 'c.md'), 'c\n');
  const res = plan(dir, [
    { from: 'a.md', to: 'archive/a.md' },
    { from: 'drafts/ch3.md', to: 'old copy.md/inside/ch3.md' },   // under a file: can't be done
    { from: 'c.md', to: 'archive/c.md' }
  ]);
  assert(res.code === 0 && res.err === '' && res.out.includes('skipped drafts/ch3.md') && res.out.includes('2 of 3 moved'), `${res.out}${res.err}`);
  const undo = run('move.mjs', ['undo'], dir);
  assert(fs.existsSync(path.join(dir, 'a.md')) && fs.existsSync(path.join(dir, 'c.md')) && undo.out.includes('Put back 2 of 2'), `${undo.out}${undo.err}`);
});

test('organize refuses .git, .margin, node_modules, the project folder and a folder moved into itself', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  const res = plan(dir, [
    { from: '.git/config', to: 'archive/gitconfig' },
    { from: 'notes/private.md', to: '.margin/private.md' },
    { from: 'drafts/ch3.md', to: 'node_modules/ch3.md' },
    { from: '.', to: 'archive/everything' },
    { from: 'notes', to: 'notes/older/notes' }
  ]);
  assert(res.out.includes('0 of 5 moved') && (res.out.match(/^skipped /gm) || []).length === 5, res.out);
  assert(fs.existsSync(path.join(dir, '.git/config')) && fs.existsSync(path.join(dir, 'notes/private.md')) && fs.existsSync(path.join(dir, 'drafts/ch3.md')), 'nothing should move');
});

test('organize reports a malformed plan step instead of crashing', () => {
  const dir = project();
  const res = plan(dir, [{ from: 'old copy.md' }, null, 'notes', { from: 1, to: 2 }, { from: 'old copy.md', to: 'archive/old copy.md' }]);
  assert(res.code === 0 && res.err === '' && (res.out.match(/needs a "from" and a "to"/g) || []).length === 4 && res.out.includes('1 of 5 moved'), `${res.out}${res.err}`);
});

test('organize undo keeps the moves it couldn\'t put back, and a second undo finishes them', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'x.md'), 'x\n');
  fs.writeFileSync(path.join(dir, 'y.md'), 'y\n');
  plan(dir, [{ from: 'x.md', to: 'archive/x.md' }, { from: 'y.md', to: 'archive/y.md' }]);
  fs.writeFileSync(path.join(dir, 'y.md'), 'a new y.md the writer made meanwhile\n');
  const first = run('move.mjs', ['undo'], dir);
  assert(first.out.includes('Put back 1 of 2') && first.out.includes('undo again') && fs.existsSync(path.join(dir, 'archive/y.md')), first.out);
  fs.renameSync(path.join(dir, 'y.md'), path.join(dir, 'y (new).md'));
  const second = run('move.mjs', ['undo'], dir);
  assert(second.out.includes('Put back 1 of 1') && readText(path.join(dir, 'y.md')) === 'y\n', second.out);
  assert(run('move.mjs', ['undo'], dir).out.includes('Nothing to undo'), 'the log should be empty now');
});

// --- Focus covers Margin's own copies of the writer's files (A-08/B-23) ---

test('focus on: backups and trashed files can\'t be read or searched; Margin\'s own files can', () => {
  const dir = project();
  setUp(dir);
  claudeEdits(dir, 'notes/private.md', 'toolu_private', 'Not for Claude. Edited.\n');   // before focus was set
  putMargin(dir, 'trash/1700000000000__secret.md', 'trashed text\n');
  run('focus.mjs', ['add', 'drafts'], dir);
  const backup = backupFiles(dir)[0];
  const denied = [
    hook(dir, 'Read', { file_path: marginPath(dir, path.join('history', backup)) }),
    hook(dir, 'Read', { file_path: marginPath(dir, 'trash/1700000000000__secret.md') }),
    hook(dir, 'Grep', { pattern: 'Claude', path: path.join(dir, '.margin') }),
    hook(dir, 'Grep', { pattern: 'Claude', path: marginPath(dir, 'history') })
  ];
  assert(denied.every((r) => decisionOf(r) === 'deny'), `copies of the writer's files should be covered: ${denied.map((r) => decisionOf(r))}`);
  for (const own of ['focus.json', 'settings.json', 'log.jsonl']) {
    assert(decisionOf(hook(dir, 'Read', { file_path: marginPath(dir, own) })) === 'allow', `${own} should stay readable`);
  }
});

// --- Focus leaves Claude Code's own session files alone (A-09/B-20) ---

function readWith(dir, filePath, extra) {
  return run('guard.mjs', [], dir, { cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: filePath }, tool_use_id: 'toolu_s', ...extra });
}

test('focus on: Claude Code\'s saved tool output and scratchpad stay readable, nothing else of its', () => {
  const dir = project();
  run('focus.mjs', ['add', 'drafts'], dir);
  const claudeHome = path.join(path.dirname(dir), 'claude home');
  const session = {
    transcript_path: path.join(claudeHome, 'projects', 'my-book', 'sess-1.jsonl'),
    scratchpad_dir: path.join(path.dirname(dir), 'scratch', 'sess-1')
  };
  assert(decisionOf(readWith(dir, path.join(claudeHome, 'projects', 'my-book', 'sess-1', 'tool-results', 'toolu_9.txt'), session)) === 'allow', 'saved tool output should be readable');
  assert(decisionOf(readWith(dir, path.join(session.scratchpad_dir, 'notes.txt'), session)) === 'allow', 'the scratchpad should be readable');
  for (const other of [path.join(claudeHome, 'settings.json'), path.join(claudeHome, 'projects', 'my-book', 'sess-2', 'tool-results', 'x.txt')]) {
    assert(decisionOf(readWith(dir, other, session)) === 'deny', `${other} should stay blocked`);
  }
});

test('a session folder inside the project opens no hole in focus', () => {
  const dir = project();
  run('focus.mjs', ['add', 'drafts'], dir);
  const inside = { transcript_path: path.join(dir, 'notes.jsonl'), scratchpad_dir: path.join(dir, 'notes') };
  assert(decisionOf(readWith(dir, path.join(dir, 'notes', 'private.md'), inside)) === 'deny', 'notes/ must stay blocked');
});

test('a read outside the project is denied with its full path and no focus suggestion', () => {
  const dir = project();
  run('focus.mjs', ['add', 'drafts'], dir);
  const outside = path.join(path.dirname(dir), 'elsewhere', 'diary.md');
  const reason = reasonOf(readWith(dir, outside, {}));
  assert(reason.includes(outside) && reason.includes('outside this project') && !reason.includes('/margin:focus add') && !reason.includes('../'), reason);
});

// --- A mistyped focus add changes nothing (A-19) ---

test('focus add with only paths that don\'t exist leaves focus as it was', () => {
  const fresh = project();
  const res = run('focus.mjs', ['add', 'drafts/chapter3.md'], fresh);
  assert(res.code === 1 && res.out.includes('Nothing was added') && res.out.includes('stays OFF'), res.out);
  assert(!fs.existsSync(marginPath(fresh, 'focus.json')), 'no focus list should be created');
  assert(decisionOf(hook(fresh, 'Read', { file_path: path.join(fresh, 'drafts/ch3.md') })) === 'allow', 'reads should not be blocked');
  const off = project();
  run('focus.mjs', ['add', 'drafts'], off);
  run('focus.mjs', ['off'], off);
  run('focus.mjs', ['add', 'nope.md'], off);
  assert(JSON.parse(readText(marginPath(off, 'focus.json'))).enabled === false, 'a list that was off stays off');
});

// --- Paths with spaces stay one path (A-18) ---

test('focus add old drafts, typed without quotes, adds "old drafts", not "drafts"', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, 'old drafts'));
  const add = run('focus.mjs', ['add', 'old', 'drafts'], dir);
  const saved = JSON.parse(readText(marginPath(dir, 'focus.json'))).paths;
  assert(saved.join('|') === 'old drafts' && add.out.includes('as one path'), `expected only "old drafts": ${saved} / ${add.out}`);
  run('focus.mjs', ['add', 'drafts'], dir);
  run('focus.mjs', ['remove', 'old', 'drafts'], dir);
  assert(JSON.parse(readText(marginPath(dir, 'focus.json'))).paths.join('|') === 'drafts', 'remove should take "old drafts" out and keep "drafts"');
});

test('skills quote each path they pass to a script', () => {
  const skills = path.join(scripts, '..', 'skills');
  for (const name of fs.readdirSync(skills)) {
    const text = fs.readFileSync(path.join(skills, name, 'SKILL.md'), 'utf8');
    assert(!/\.mjs" --project "\$\{CLAUDE_PROJECT_DIR\}" \$ARGUMENTS/.test(text), `${name}/SKILL.md passes $ARGUMENTS unquoted`);
  }
});

// --- Links can't carry a read outside focus (A-20) ---

test('focus: a link inside a focus folder that points outside it is denied', () => {
  const dir = project();
  // A junction on Windows (no admin rights needed), a symlink elsewhere.
  fs.symlinkSync(path.join(dir, 'notes'), path.join(dir, 'drafts', 'research'), 'junction');
  run('focus.mjs', ['add', 'drafts'], dir);
  assert(readText(path.join(dir, 'drafts', 'research', 'private.md')) === 'Not for Claude.\n', 'the link should work at the OS level');
  assert(decisionOf(hook(dir, 'Read', { file_path: path.join(dir, 'drafts', 'research', 'private.md') })) === 'deny', 'reading through the link must be denied');
  assert(decisionOf(hook(dir, 'Grep', { pattern: 'Claude', path: path.join(dir, 'drafts', 'research') })) === 'deny', 'searching through the link must be denied');
  assert(decisionOf(hook(dir, 'Read', { file_path: path.join(dir, 'drafts', 'ch3.md') })) === 'allow', 'ordinary files in the folder stay readable');
});

test('focus: a link from outside that points into a focus folder reads what focus allows', () => {
  const dir = project();
  fs.symlinkSync(path.join(dir, 'drafts'), path.join(dir, 'notes', 'current'), 'junction');
  run('focus.mjs', ['add', 'drafts'], dir);
  assert(decisionOf(hook(dir, 'Read', { file_path: path.join(dir, 'notes', 'current', 'ch3.md') })) === 'allow', 'the real file is in the focus list');
  assert(decisionOf(hook(dir, 'Read', { file_path: path.join(dir, 'drafts', 'not-yet.md') })) === 'allow', 'a file that doesn\'t exist yet in a focus folder is still inside it');
});

// --- Drives that ignore case (A-21) ---

const driveIgnoresCase = (dir) => fs.existsSync(path.join(dir, 'DRAFTS'));

test('focus add stores names as they are on disk', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, 'Research'));
  fs.writeFileSync(path.join(dir, 'Research', 'Interviews.md'), 'x\n');
  const res = run('focus.mjs', ['add', 'research/interviews.md'], dir);
  if (driveIgnoresCase(dir)) {
    assert(JSON.parse(readText(marginPath(dir, 'focus.json'))).paths.join() === 'Research/Interviews.md', `expected the on-disk spelling: ${res.out}`);
  } else {
    assert(res.out.includes('Not found'), 'on a case-sensitive drive the typed name is a different file');
  }
});

test('path comparisons follow the drive, not the OS: a macOS-style run on a drive that ignores case', () => {
  const dir = project();
  const preload = path.join(dir, 'as-macos.cjs');
  fs.writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'darwin' });\n");
  const lib = pathToFileURL(path.join(scripts, 'lib.mjs')).href;
  const code = `const l = await import(${JSON.stringify(lib)}); l.projectDir(); console.log(l.IS_WINDOWS, l.isInside(${JSON.stringify(path.join(dir, 'drafts', 'ch3.md'))}, ${JSON.stringify(path.join(dir, 'DRAFTS'))}));`;
  const res = spawnSync(process.execPath, ['-r', preload, '--input-type=module', '-e', code], { cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8' });
  assert(res.stdout.trim() === `false ${driveIgnoresCase(dir)}`, `expected "false ${driveIgnoresCase(dir)}": ${res.stdout}${res.stderr}`);
});

// A2-11/B2-11: remove follows the drive's case rule and says when a name isn't listed.
test('focus remove matches names as the drive does and says when one isn\'t in the list (A2-11/B2-11)', () => {
  const dir = project();
  run('focus.mjs', ['add', 'drafts', 'notes'], dir);
  const stored = () => JSON.parse(readText(marginPath(dir, 'focus.json'))).paths.join();
  const upper = run('focus.mjs', ['remove', 'DRAFTS'], dir);
  if (driveIgnoresCase(dir)) {
    assert(stored() === 'notes' && !upper.out.includes('Not in the list'), `DRAFTS is drafts on this drive: ${upper.out}`);
  } else {
    assert(stored() === 'drafts,notes' && upper.out.includes('Not in the list: DRAFTS.'), `DRAFTS is another name on this drive: ${upper.out}`);
  }
  const before = fs.statSync(marginPath(dir, 'focus.json')).mtimeMs;
  const none = run('focus.mjs', ['remove', 'chapters'], dir);
  assert(none.code === 0 && none.out.startsWith('Not in the list: chapters.') && fs.statSync(marginPath(dir, 'focus.json')).mtimeMs === before, `${none.out}`);
});

// --- Shell commands under focus (A-04/B-04, K7) ---

const shellCheck = await import(pathToFileURL(path.join(scripts, 'shell-check.mjs')).href);
const marginLib = await import(pathToFileURL(path.join(scripts, 'lib.mjs')).href);
const k7 = project();
run('focus.mjs', ['add', 'drafts', 'notes/interviews.md'], k7);
const k7rules = marginLib.focusRules(k7, {}, marginLib.readFocus(k7));
const fwdSlashes = (p) => p.split(path.sep).join('/');
const decideShell = (dialect, command) => {
  const r = shellCheck.decide(command, { dialect, cwd: k7, scriptsDir: scripts, root: k7, rules: k7rules });
  return r ? r.decision : 'allow';
};
// [dialect, command, expected]: the command lists from both round-1 reviews, plus edge cases.
const SHELL_TABLE = [
  ['bash', 'ls -la notes', 'allow'], ['bash', 'find . -name "*.md"', 'allow'], ['bash', 'git status', 'allow'], ['bash', 'npm test', 'allow'],
  ['bash', 'echo "notes/private.md is off limits"', 'allow'], ['bash', "printf '%s\\n' notes/private.md", 'allow'],
  ['bash', 'cat drafts/ch3.md', 'allow'], ['bash', 'cat drafts/ch3.md notes/interviews.md', 'allow'], ['bash', 'grep -n TODO drafts/ch3.md', 'allow'],
  ['bash', 'grep -n mill drafts/ch3.md', 'allow'], ['bash', 'wc -w drafts/*.md', 'allow'], ['bash', 'pandoc drafts/ch3.md -o out.pdf', 'allow'],
  ['bash', 'head -5 notes\\private.md', 'allow'],                     // bash drops the backslash: notesprivate.md doesn't exist
  ['bash', `node "${fwdSlashes(scripts)}/inventory.mjs" --project "${fwdSlashes(k7)}"`, 'allow'],
  ['bash', `node "${fwdSlashes(scripts)}/focus.mjs" --project "${fwdSlashes(k7)}" status`, 'allow'],
  ['bash', "cat > drafts/new.md <<'EOF'\nhead notes/private.md\nEOF", 'allow'],   // a heredoc body is data
  ['bash', 'mkdir -p archive && mv notes/private.md archive/', 'allow'], ['bash', 'echo hi > notes/private.md', 'allow'],
  ['bash', 'sed -n 1,5p drafts/ch3.md', 'allow'], ['bash', 'cd drafts && cat ch3.md', 'allow'], ['bash', 'cat notes/interviews.md', 'allow'],
  ['bash', 'cat ./notes/../drafts/ch3.md', 'allow'], ['bash', 'grep -r mill drafts', 'allow'], ['bash', 'rg -n mill drafts/ch3.md', 'allow'],
  ['bash', '# cat notes/private.md', 'allow'],
  ['bash', 'cat notes/private.md', 'deny'], ['bash', 'head -20 notes/private.md', 'deny'], ['bash', 'head -5 notes/private.md', 'deny'],
  ['bash', 'tail -f notes/private.md', 'deny'], ['bash', 'less notes/private.md', 'deny'], ['bash', 'bat notes/private.md', 'deny'],
  ['bash', 'sed -n 1,5p notes/private.md', 'deny'], ['bash', "awk '{print $1}' notes/private.md", 'deny'], ['bash', 'cat drafts/../notes/private.md', 'deny'],
  ['bash', 'cd notes && cat private.md', 'deny'], ['bash', '( cd notes; cat private.md )', 'deny'], ['bash', 'cat < notes/private.md', 'deny'],
  ['bash', 'cat drafts/ch3.md notes/private.md', 'deny'], ['bash', 'cat notes/private.md 2>/dev/null', 'deny'], ['bash', 'cat -n notes/private.md | head', 'deny'],
  ['bash', 'grep -rn mill .', 'deny'], ['bash', 'grep -r mill .', 'deny'], ['bash', 'grep -n mill drafts/ch3.md notes/private.md', 'deny'],
  ['bash', 'grep -e mill notes/private.md', 'deny'], ['bash', 'grep -f notes/private.md drafts/ch3.md', 'deny'], ['bash', 'rg mill', 'deny'],
  ['bash', 'rg mill notes', 'deny'], ['bash', 'diff drafts/ch3.md notes/private.md', 'deny'], ['bash', 'cp notes/private.md drafts/copy.md', 'deny'],
  ['bash', 'F=notes/private.md; cat "$F"', 'deny'], ['bash', 'export F=notes/private.md && cat $F', 'deny'],
  ['bash', 'bash -c "cat notes/private.md"', 'deny'], ['bash', "sh -c 'head -1 notes/private.md'", 'deny'],
  ['bash', 'sudo cat notes/private.md', 'deny'], ['bash', 'env LC_ALL=C cat notes/private.md', 'deny'], ['bash', 'timeout 5 cat notes/private.md', 'deny'],
  ['bash', 'find . -name "*.md" -exec cat {} +', 'deny'], ['bash', 'find notes -name "*.md" | xargs cat', 'deny'],
  ['bash', 'cat */private.md', 'deny'], ['bash', 'cat notes/*.md', 'deny'], ['bash', 'cat drafts/ch3.md &&\\\n cat notes/private.md', 'deny'],
  ['bash', `cat "${fwdSlashes(k7)}/notes/private.md"`, 'deny'],
  ['bash', 'node -e "console.log(require(\'fs\').readFileSync(\'notes/private.md\',\'utf8\'))"', 'ask'],
  ['bash', 'python summarize.py notes/private.md', 'ask'], ['bash', 'python3 - <<\'EOF\'\nprint(open("notes/private.md").read())\nEOF', 'ask'],
  ['bash', 'cat "$UNKNOWN_FILE"', 'ask'], ['bash', 'cat $(ls)', 'ask'], ['bash', 'cat $(ls notes)', 'ask'], ['bash', 'cat $(echo notes/private.md)', 'ask'],
  ['bash', 'xargs cat < filelist.txt', 'ask'], ['bash', 'git diff notes/private.md', 'ask'], ['bash', 'for f in notes/*.md; do head -1 "$f"; done', 'ask'],
  ['powershell', 'Get-ChildItem notes', 'allow'], ['powershell', 'Get-Content drafts\\ch3.md', 'allow'],
  ['powershell', 'Get-Content -Path .\\drafts\\ch3.md -TotalCount 5', 'allow'], ['powershell', 'Write-Output "notes\\private.md is off limits"', 'allow'],
  ['powershell', 'Test-Path notes\\private.md', 'allow'], ['powershell', 'Get-ChildItem drafts | Get-Content', 'allow'],
  ['powershell', 'Set-Content notes\\private.md "x"', 'allow'], ['powershell', '# Get-Content notes\\private.md', 'allow'],
  ['powershell', 'Get-Content notes\\private.md', 'deny'], ['powershell', 'gc .\\notes\\private.md | Select-Object -First 5', 'deny'],
  ['powershell', 'type notes\\private.md', 'deny'], ['powershell', 'cat notes\\private.md', 'deny'], ['powershell', 'head -5 notes\\private.md', 'deny'],
  ['powershell', "Get-Content -LiteralPath 'notes\\private.md'", 'deny'], ['powershell', 'gc notes\\private.md -Tail 3', 'deny'],
  ['powershell', 'Import-Csv notes\\private.md', 'deny'], ['powershell', 'Get-Content drafts\\ch3.md, notes\\private.md', 'deny'],
  ['powershell', 'Select-String -Pattern mill -Path notes\\*.md', 'deny'], ['powershell', 'Select-String -Path notes\\* mill', 'deny'],
  ['powershell', 'Select-String mill notes\\private.md', 'deny'], ['powershell', 'Get-ChildItem -Recurse notes | Select-String mill', 'deny'],
  ['powershell', 'Copy-Item notes\\private.md drafts\\copy.md', 'deny'], ['powershell', 'Set-Location notes; Get-Content private.md', 'deny'],
  ['powershell', 'powershell -Command "Get-Content notes\\private.md"', 'deny'], ['powershell', '$f = "notes\\private.md"; Get-Content $f', 'deny'],
  ['powershell', 'findstr /s mill *.md', 'deny'],
  ['powershell', 'Get-ChildItem drafts | ForEach-Object { Get-Content $_ }', 'ask'], ['powershell', 'Get-Content (Join-Path notes private.md)', 'ask'],
  ['powershell', 'node -e "console.log(require(\'fs\').readFileSync(\'notes/private.md\',\'utf8\'))"', 'ask'],
  // Round 2 (A2-03/B2-02): a cd inside a subshell or $( ) doesn't outlast it; pushd/popd.
  ['bash', '(cd notes && ls); cat notes/private.md', 'deny'], ['bash', 'd=$(cd drafts && pwd); cat notes/private.md', 'deny'],
  ['bash', 'pushd drafts >/dev/null && popd >/dev/null && cat notes/private.md', 'deny'], ['bash', 'popd; cat notes/private.md', 'ask'],
  ['powershell', 'Push-Location notes; Pop-Location; Get-Content notes\\private.md', 'deny'],
  ['bash', '(cd drafts && cat ch3.md)', 'allow'], ['bash', 'pushd notes && popd && cat drafts/ch3.md', 'allow'],
  // eval and Invoke-Expression run their argument as code.
  ['bash', 'eval "cat notes/private.md"', 'deny'], ['bash', "eval 'head -3 notes/private.md'", 'deny'], ['bash', "eval 'cat notes/private.md'", 'deny'],
  ['powershell', 'Invoke-Expression "Get-Content notes\\private.md"', 'deny'], ['powershell', "Invoke-Expression 'Get-Content notes\\private.md'", 'deny'],
  ['powershell', "iex 'Get-Content notes\\private.md'", 'deny'], ['powershell', "iex 'gc notes/private.md'", 'deny'],
  ['bash', 'eval "cat drafts/ch3.md"', 'allow'], ['powershell', "iex 'Get-Content drafts\\ch3.md'", 'allow'],
  // .NET calls in PowerShell, and $PWD.
  ['powershell', "[IO.File]::ReadAllText('notes\\private.md')", 'ask'], ['powershell', '[System.IO.File]::ReadAllLines("notes\\private.md")', 'ask'],
  ['powershell', "[System.IO.File]::ReadAllText('notes\\private.md')", 'ask'], ['powershell', '[IO.File]::ReadAllText("$PWD\\notes\\private.md")', 'ask'],
  ['powershell', "$t = [IO.File]::ReadAllText('notes\\private.md', [Text.Encoding]::UTF8); $t", 'ask'],
  ['powershell', '[System.IO.File]::ReadAllText((Resolve-Path notes\\private.md))', 'ask'], ['powershell', "'notes\\private.md' | Get-Content", 'ask'],
  ['powershell', "[IO.File]::ReadAllText('drafts\\ch3.md')", 'allow'], ['powershell', '[Math]::Round(3.14159, 2)', 'allow'],
  ['powershell', "& 'C:\\Windows\\System32\\where.exe' notepad", 'allow'], ['powershell', '$PWD', 'allow'],
  ['bash', 'cat "$PWD/notes/private.md"', 'deny'], ['bash', 'cat "$PWD/drafts/ch3.md"', 'allow'],
  // A here-document whose delimiter isn't quoted expands $( ) in its body.
  ['bash', 'cat > drafts/new.md <<EOF\n$(cat notes/private.md)\nEOF', 'deny'], ['bash', "cat > drafts/new.md <<'EOF'\n$(cat notes/private.md)\nEOF", 'allow'],
  // xargs -a, fd -x, awk programs that open files.
  ['bash', 'xargs -a notes/private.md echo', 'deny'], ['bash', 'xargs -a drafts/ch3.md echo', 'allow'],
  ['bash', 'fd -e md -x cat {}', 'deny'], ['bash', 'fd -x cat', 'deny'], ['bash', 'fd -e md', 'allow'], ['bash', 'fd -e md . drafts -x cat {}', 'allow'],
  ['bash', "awk 'BEGIN{while((getline l < \"notes/private.md\")>0) print l}'", 'ask'], ['bash', "awk '{print $1}' drafts/ch3.md", 'allow'],
  // A2-04: PowerShell switch aliases and abbreviations (gci -r is -Recurse).
  ['powershell', 'gci -r drafts | sls mill', 'allow'], ['powershell', 'ls drafts -r -Filter *.md | sls mill', 'allow'],
  ['powershell', 'Get-ChildItem -Rec -Path drafts | Select-String mill', 'allow'], ['powershell', 'gci -af -r drafts | sls mill', 'allow'],
  ['powershell', 'gci -r | sls mill', 'deny'], ['powershell', 'gci -s notes | sls mill', 'deny'],
  // B2-03: device files hold no text of the writer's, whether or not they exist on this OS.
  ['bash', 'cat < /dev/null', 'allow'], ['bash', 'grep x /dev/null', 'allow'], ['bash', 'diff drafts/ch3.md /dev/null', 'allow'],
  ['bash', 'npm test < /dev/null', 'allow'], ['bash', 'head -c 10 /dev/urandom', 'allow'], ['bash', 'cat /dev/stdin', 'allow'],
  ['bash', 'cat /dev/fd/3', 'allow'], ['bash', 'cat /dev/null notes/private.md', 'deny'], ['bash', 'cat /dev/nullx', 'allow'],
  // B2-04: git commands that print no file contents, and a bare "." , don't ask; the ones that can still do.
  ['bash', 'git add .', 'allow'], ['bash', 'git status .', 'allow'], ['bash', 'git checkout -- notes/private.md', 'allow'],
  ['bash', 'pip install .', 'allow'], ['bash', 'git add -A . && git commit -m "x"', 'allow'], ['bash', 'git -C notes status', 'allow'],
  ['bash', 'git -c core.quotepath=off add notes/private.md', 'allow'], ['bash', 'git mv notes/private.md archive/p.md', 'allow'],
  ['bash', 'git diff notes/private.md', 'ask'], ['bash', 'git show HEAD:notes/private.md', 'allow'], ['bash', 'git blame notes/private.md', 'ask'],
  ['bash', 'git log -p notes/private.md', 'ask'], ['bash', 'git stash show notes/private.md', 'ask'], ['bash', 'git diff --no-index /dev/null notes/private.md', 'ask'],
  ['bash', 'git $SUB notes/private.md', 'ask'], ['powershell', 'git add .', 'allow'], ['powershell', 'git diff notes\\private.md', 'ask'],
  // T4: switches don't swallow the file after them (column -t, od -w); real value options still do.
  ['bash', 'column -t notes/private.md', 'deny'], ['bash', 'column -t drafts/ch3.md', 'allow'], ['bash', 'column -s , -t notes/private.md', 'deny'],
  ['bash', 'od -w notes/private.md', 'deny'], ['bash', 'od -w16 -c notes/private.md', 'deny'], ['bash', 'od -t x1 drafts/ch3.md', 'allow'],
  // T2: a bare folder name counts after `--` and for archivers; other programs still need a / or an extension.
  ['bash', 'tar czf - sources | tar xzOf -', 'ask'], ['bash', 'tar czf - drafts | tar xzOf -', 'allow'], ['bash', 'tar -C sources -cf - . | tar -xOf -', 'ask'],
  ['bash', 'ditto -c -k sources - | funzip', 'ask'], ['bash', 'zip -qr - sources | funzip', 'ask'], ['bash', 'git show HEAD -- sources', 'ask'],
  ['bash', 'git log -p -- sources', 'ask'], ['bash', 'git show HEAD -- drafts', 'allow'], ['bash', 'make sources', 'allow'], ['bash', 'npm run sources', 'allow'],
  ['powershell', 'Compress-Archive -Path sources -DestinationPath out.zip', 'ask'], ['powershell', 'tar -cf - sources', 'ask'],
  // T3: git grep is a search of its paths, else of the folder it runs in.
  ['bash', 'git grep mills', 'deny'], ['bash', 'git grep mills HEAD', 'deny'], ['bash', 'git grep -n mills -- sources', 'deny'],
  ['bash', 'git grep mills -- drafts', 'allow'], ['bash', 'git grep mills drafts', 'allow'], ['bash', 'git grep -e mills -e Hale -- drafts', 'allow'],
  ['bash', 'git grep mills -- "*.md"', 'deny'], ['bash', 'git -C drafts grep mills', 'allow'], ['bash', 'git -C sources grep mills', 'deny'],
  ['bash', 'cd drafts && git grep mills', 'allow'], ['bash', 'git grep -f notes/private.md drafts', 'deny'], ['bash', 'git grep mills -- :/', 'ask'],
  ['bash', 'git -C $DIR grep mills', 'ask'], ['bash', 'git --no-pager grep -C 2 mills drafts', 'allow'], ['powershell', 'git grep mills', 'deny']
];

test('focus on: shell commands are allowed, denied or asked about as the table says', () => {
  const wrong = SHELL_TABLE.filter(([dialect, command, expected]) => decideShell(dialect, command) !== expected)
    .map(([dialect, command, expected]) => `${dialect}: ${JSON.stringify(command)} expected ${expected}, got ${decideShell(dialect, command)}`);
  assert(!wrong.length, `\n       ${wrong.join('\n       ')}`);
});

test('focus on: the shell check stays fast', () => {
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < 10; i++) for (const [dialect, command] of SHELL_TABLE.slice(0, 100)) decideShell(dialect, command);
  const thousand = Number(process.hrtime.bigint() - t0) / 1e6;
  const long = Array.from({ length: 200 }, (_, i) => `grep -n word${i} drafts/ch3.md`).join(' && ');
  t0 = process.hrtime.bigint();
  decideShell('bash', long);
  const longMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert(thousand < 2000 && longMs < 50, `1,000 checks took ${thousand.toFixed(0)} ms, a 200-part command ${longMs.toFixed(1)} ms`);
});

// A2-05: PowerShell takes \ between folders on every system; Node's path module only on
// Windows. Elsewhere the PowerShell words get / first, so the table above holds there too.
test('PowerShell paths written with \\ are paths on macOS and Linux too (A2-05)', () => {
  assert(shellCheck.psSeparators('notes\\private.md', 'linux') === 'notes/private.md', 'linux');
  assert(shellCheck.psSeparators('.\\notes\\private.md', 'darwin') === './notes/private.md', 'darwin');
  assert(shellCheck.psSeparators('notes\\private.md', 'win32') === 'notes\\private.md', 'Windows keeps \\');
  // The tokenizer applies it: a run that reports a POSIX platform sees / in a PowerShell word.
  const dir = project();
  const preload = path.join(dir, 'as-linux.cjs');
  fs.writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'linux' });\n");
  const sc = pathToFileURL(path.join(scripts, 'shell-check.mjs')).href;
  const code = `const s = await import(${JSON.stringify(sc)}); const r = s.classify('Get-Content $x\\\\notes\\\\private.md', { dialect: 'powershell', cwd: ${JSON.stringify(dir)} }); console.log(r.unknown[0].word);`;
  const res = spawnSync(process.execPath, ['-r', preload, '--input-type=module', '-e', code], { cwd: dir, encoding: 'utf8' });
  assert(res.stdout.trim() === '/notes/private.md', `expected "/notes/private.md": ${res.stdout}${res.stderr}`);
});

function shellHook(dir, tool, command, extraEnv = {}) {
  return run('shell-guard.mjs', [], dir, { cwd: dir, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, tool_use_id: 'toolu_sh' }, extraEnv);
}

test('the shell guard hook: same reasons as Read, both shells, silent when focus is off', () => {
  const denied = shellHook(k7, 'Bash', 'cat notes/private.md');
  assert(decisionOf(denied) === 'deny' && reasonOf(denied).includes('/margin:focus add notes/private.md'), `${denied.out}${denied.err}`);
  assert(decisionOf(shellHook(k7, 'PowerShell', 'Get-Content notes\\private.md')) === 'deny', 'PowerShell should be covered too');
  assert(shellHook(k7, 'Bash', 'cat drafts/ch3.md').out === '', 'an allowed command gets no answer');
  const outsideFile = path.join(path.dirname(k7), `outside ${path.basename(k7)}.md`);
  fs.writeFileSync(outsideFile, 'elsewhere\n');
  const outside = reasonOf(shellHook(k7, 'Bash', `cat "${fwdSlashes(outsideFile)}"`));
  fs.rmSync(outsideFile, { force: true });
  assert(outside.includes('outside this project') && !outside.includes('/margin:focus add'), outside);
  const off = project();
  run('focus.mjs', ['add', 'drafts'], off);
  run('focus.mjs', ['off'], off);
  assert(shellHook(off, 'Bash', 'cat notes/private.md').out === '', 'focus off: no answer');
  assert(shellHook(project(), 'Bash', 'cat notes/private.md').out === '', 'no focus list: no answer');
  const hooks = JSON.parse(fs.readFileSync(path.join(scripts, '..', 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse;
  assert(hooks.some((h) => h.matcher === 'Bash|PowerShell' && h.hooks[0].command.includes('shell-guard.mjs')), 'hooks.json should register the shell guard');
});

test('the shell guard: a damaged focus list pauses shell reads; its own failure asks, never blocks', () => {
  const dir = project();
  putMargin(dir, 'focus.json', '{"enabled": true, "paths": ["dra');
  const read = shellHook(dir, 'Bash', 'cat drafts/ch3.md');
  assert(decisionOf(read) === 'deny' && reasonOf(read).includes('/margin:focus status'), `${read.out}${read.err}`);
  assert(shellHook(dir, 'Bash', 'ls -la').out === '', 'listing is still fine');
  const failed = shellHook(k7, 'Bash', 'cat notes/private.md', { MARGIN_TEST_FAIL: 'shell-guard' });
  assert(failed.code === 0 && decisionOf(failed) === 'ask', `${failed.out}${failed.err}`);
});

// --- Margin notes as flags, for every shell (A-10/B-09) ---

const storedNotes = (dir) => JSON.parse(readText(marginPath(dir, 'suggestions.json'))).items;

test('notes can be queued with flags, with quotes, apostrophes and accents intact', () => {
  const dir = project();
  const message = 'Says ‘1871’ here; it’s café — notes say "1874".';
  const res = run('suggestions.mjs', ['add', '--file', 'drafts/ch3.md', '--line', '12', '--kind', 'contradiction', '--message', message, '--source', 'notes/interviews.md:40'], dir);
  const [n] = storedNotes(dir);
  assert(res.code === 0 && n.message === message && n.line === 12 && n.kind === 'contradiction' && n.source === 'notes/interviews.md:40' && n.file === 'drafts/ch3.md', `${res.out}${JSON.stringify(n)}`);
});

test('several notes can be queued in one command; a wrong flag queues nothing', () => {
  const dir = project();
  run('suggestions.mjs', ['add', '--file', 'drafts/ch3.md', '--line', '1', '--kind', 'todo', '--message', 'one', '--file', 'drafts/ch3.md', '--line', '2', '--message', 'two'], dir);
  const notes = storedNotes(dir);
  assert(notes.length === 2 && notes[0].message === 'one' && notes[1].message === 'two' && notes[1].kind === 'note', JSON.stringify(notes));
  const other = project();
  const bad = run('suggestions.mjs', ['add', '--file', 'drafts/ch3.md', '--colour', 'red', '--message', 'x'], other);
  assert(bad.code === 1 && bad.out.includes('Unknown option') && !fs.existsSync(marginPath(other, 'suggestions.json')), bad.out);
});

test('notes queued through Windows PowerShell 5.1 arrive intact (Windows only)', () => {
  if (process.platform !== 'win32') return;
  const dir = project();
  const message = 'Says ‘1871’ here; it’s café — notes say 1874.';
  const ps = `& '${process.execPath}' '${path.join(scripts, 'suggestions.mjs')}' --project '${dir}' add --file "drafts/ch3.md" --line 12 --kind contradiction --message "${message}"`;
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { cwd: dir, encoding: 'utf8', input: '', timeout: 60000 });
  if (res.error && res.error.code === 'ENOENT') return;   // no Windows PowerShell on this machine
  const notes = fs.existsSync(marginPath(dir, 'suggestions.json')) ? storedNotes(dir) : [];
  assert(notes.length === 1 && notes[0].message === message && notes[0].line === 12, `${res.stdout}${res.stderr}${JSON.stringify(notes)}`);
});

test('the check and cite skills queue notes with flags, and every skill allows its node scripts in PowerShell too', () => {
  const skills = path.join(scripts, '..', 'skills');
  const read = (name) => fs.readFileSync(path.join(skills, name, 'SKILL.md'), 'utf8');
  for (const name of ['check', 'cite']) {
    assert(read(name).includes('suggestions.mjs" --project "${CLAUDE_PROJECT_DIR}" add --file') && !/add '[\[{]/.test(read(name)), `${name} should use flags`);
  }
  for (const name of fs.readdirSync(skills)) {
    const tools = /^allowed-tools:(.*)$/m.exec(read(name))[1];
    assert(tools.includes('Bash(node *)') && tools.includes('PowerShell(node *)'), `${name}: ${tools}`);
  }
});

// --- Citations against realistic libraries and drafts (A-14/B-17/B-18, A-17, A-37) ---

const citeCheck = await import(pathToFileURL(path.join(scripts, 'cite-check.mjs')).href);
const fixtures = path.join(here, 'fixtures');
const ALL_KEYS = 'hale2018,smith2020:deep-learning,tiny2019,doe.2019,essays2019,UPPER2018,web2021,energy2017,mueller2021,paren2016,last2022';

test('BibTeX: every entry of a realistic export is found; @comment, @preamble and @string are skipped', () => {
  const lib = citeCheck.parseBib(readText(path.join(fixtures, 'zotero-export.bib')));
  assert([...lib.keys()].join(',') === ALL_KEYS, [...lib.keys()].join(','));
  assert(lib.get('web2021').year === '2021' && lib.get('mueller2021').title === 'Über die Mühlen' &&
    lib.get('hale2018').title === 'Mills of the Estuary: A History of Tide Power' && lib.get('smith2020:deep-learning').author === 'Smith, Ann and Müller, Jörg' &&
    lib.get('tiny2019').title === 'A One-Line Entry' && lib.get('paren2016').year === '2016', JSON.stringify([...lib]));
});

test('BibTeX: a byte-order mark and Windows line endings are read normally', () => {
  const text = '﻿' + readText(path.join(fixtures, 'zotero-export.bib')).replace(/\n/g, '\r\n');
  assert([...citeCheck.parseBib(text).keys()].join(',') === ALL_KEYS, 'all entries expected');
});

test('citations: natbib, biblatex, multi-line and unicode forms are found; code, comments and front matter are not', () => {
  const md = citeCheck.findCitations(readText(path.join(fixtures, 'citations.md')), 'markdown').map((c) => `${c.key}@${c.line}:${c.form}`).join(' ');
  const expectedMd = 'smith2020:deep-learning@6:bracketed doe.2019@6:bracketed hale2018@6:bracketed web2021@7:bare müller2021@7:bracketed annwrites@8:bare ' +
    'hale2018@10:latex doe.2019@10:latex energy2017@10:latex tiny2019@10:latex last2022@11:latex UPPER2018@11:latex essays2019@11:latex mueller2021@11:latex ' +
    'hale2018@12:latex doe.2019@12:latex web2021@12:latex paren2016@13:latex energy2017@14:latex ' +
    'fig:plot@24:bracketed tbl:results@24:bare eq:one@24:bracketed sec:intro@24:bare lst:code@24:bare';
  assert(md === expectedMd, `\n       got      ${md}\n       expected ${expectedMd}`);
  const tex = citeCheck.findCitations(readText(path.join(fixtures, 'citations.tex')), 'tex').map((c) => `${c.key}@${c.line}`).join(' ');
  assert(tex === 'hale2018@3 doe.2019@3 energy2017@5 tiny2019@9 last2022@9 hale2018@10 energy2017@10 tiny2019@10 last2022@10', tex); // B2-08: \Cite, \Citep, \Cites
});

test('pandoc-crossref labels are not reported as missing citations, unless the library has such a key (B2-08)', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'drafts', 'xref.md'), 'See [@fig:plot], @tbl:results and [@eq:one; @smith2020], also [@fig:real] and [@missing2020].\n');
  fs.appendFileSync(path.join(dir, 'sources', 'library.bib'), '\n@misc{fig:real, title = {A key that looks like a label}, year = {2020}}\n');
  const report = JSON.parse(run('cite-check.mjs', ['drafts/xref.md'], dir).out);
  assert(report.unresolved.map((u) => u.key).join() === 'missing2020', JSON.stringify(report.unresolved.map((u) => u.key)));
  assert(report.citations === 3 && report.resolved === 2, `${report.citations} citations, ${report.resolved} resolved`);
});

test('the library is the bibliography setting, else the newest .bib, with the others listed', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, 'zotero-backup'));
  const backup = path.join(dir, 'zotero-backup', '2019-library.bib');
  fs.writeFileSync(backup, '@book{smith2020,\n  title = {Old Copy},\n  year = {2020}\n}\n');
  const old = new Date(Date.now() - 400 * 86400000);
  fs.utimesSync(backup, old, old);
  const auto = JSON.parse(run('cite-check.mjs', ['drafts/ch3.md'], dir).out);
  assert(auto.library === 'sources/library.bib' && auto.libraryChosenBy === 'newest' && auto.libraryCandidates.join() === 'sources/library.bib,zotero-backup/2019-library.bib', JSON.stringify(auto));
  run('settings.mjs', ['set', 'bibliography', 'zotero-backup/2019-library.bib'], dir);
  const chosen = JSON.parse(run('cite-check.mjs', ['drafts/ch3.md'], dir).out);
  assert(chosen.library === 'zotero-backup/2019-library.bib' && chosen.libraryChosenBy === 'setting' && !chosen.libraryCandidates, JSON.stringify(chosen));
});

test('a missing or empty library is an error, not a list of every key', () => {
  const dir = project();
  const missing = JSON.parse(run('cite-check.mjs', ['drafts/ch3.md', 'sources/nope.bib'], dir).out);
  assert(missing.error === 'library_missing' && missing.unresolved.length === 0, JSON.stringify(missing));
  fs.writeFileSync(path.join(dir, 'sources', 'empty.bib'), '% nothing here yet\n');
  const empty = JSON.parse(run('cite-check.mjs', ['drafts/ch3.md', 'sources/empty.bib'], dir).out);
  assert(empty.error === 'library_empty' && empty.unresolved.length === 0, JSON.stringify(empty));
  const none = project();
  fs.rmSync(path.join(none, 'sources', 'library.bib'));
  assert(JSON.parse(run('cite-check.mjs', ['drafts/ch3.md'], none).out).error === 'no_library', 'no library at all');
});

test('close matches come with author, year and title, each occurrence says its form, distinct keys are counted', () => {
  const r = JSON.parse(run('cite-check.mjs', ['drafts/ch3.md'], project()).out);
  const u = r.unresolved[0];
  const d = u && u.closeMatchDetails[0];
  assert(u.key === 'smtih2020' && u.form === 'latex' && d.key === 'smith2020' && d.author === 'Smith, Ann' && d.year === '2020' && d.title === 'Tide Mills', JSON.stringify(u));
  assert(r.citations === 3 && r.distinctKeys === 3 && r.resolved === 2, JSON.stringify(r));
});

test('the cite and check skills handle library errors and bare @mentions', () => {
  const read = (name) => fs.readFileSync(path.join(scripts, '..', 'skills', name, 'SKILL.md'), 'utf8');
  for (const word of ['library_missing', 'library_empty', 'no_library', 'closeMatchDetails', 'form: "bare"', 'libraryCandidates']) assert(read('cite').includes(word), `cite: ${word}`);
  for (const word of ['error', 'form: "bare"']) assert(read('check').includes(word), `check: ${word}`);
});

// --- Organize's inventory reads only what can be a duplicate (A-29/B-29, K6) ---

const inventory = await import(pathToFileURL(path.join(scripts, 'inventory.mjs')).href);

test('inventory reads only files that share a size with another file, and finds the identical ones', () => {
  const dir = project();
  const make = (name, size, seed) => {
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = (i * 31 + seed * 7) % 251;
    fs.writeFileSync(path.join(dir, name), buf);
    return { full: path.join(dir, name), bytes: size, path: name };
  };
  const unique = Array.from({ length: 10 }, (_, i) => make(`unique-${i}.pdf`, 100000 + i * 997, i));
  const same1 = make('scan.pdf', 300000, 1);
  const same2 = make('scan copy.pdf', 300000, 1);
  const tailA = make('tail-a.pdf', 200000, 2);
  const tailB = make('tail-b.pdf', 200000, 2);
  const t = fs.readFileSync(tailB.full); t[199999] ^= 0xff; fs.writeFileSync(tailB.full, t);   // same size and start, different end
  const headA = make('head-a.pdf', 150000, 3);
  const headB = make('head-b.pdf', 150000, 4);
  const files = [...unique, same1, same2, tailA, tailB, headA, headB];
  const readBytes = new Map();
  const groups = inventory.findDuplicates(files, { onRead: (n, file) => readBytes.set(file, (readBytes.get(file) || 0) + n) });
  assert(groups.length === 1 && groups[0].map((f) => f.path).join() === 'scan.pdf,scan copy.pdf', JSON.stringify(groups.map((g) => g.map((f) => f.path))));
  assert(unique.every((f) => !readBytes.has(f.full)), 'files of a unique size must not be read');
  assert(readBytes.get(headA.full) === 65536 && readBytes.get(headB.full) === 65536, 'different starts: only the first 64 KB is read');
  assert(readBytes.get(tailA.full) === 65536 + 200000 && readBytes.get(same1.full) === 65536 + 300000, 'same start: the whole file is compared');
});

// A2-02/B2-01: a plugin reached through a link (a symlinked ~/.claude, --plugin-dir on a
// linked folder, macOS /tmp) still runs inventory and cite-check. The link points at a
// copy of the plugin, never at the repo, and is removed first.
test('inventory and cite-check still report when the plugin path goes through a link (A2-02/B2-01)', () => {
  const dir = project();
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'margin link '));
  made.push(holder);
  const copy = path.join(holder, 'real plugin');
  fs.cpSync(path.join(scripts, '..'), copy, { recursive: true });
  const link = path.join(holder, 'linked plugin');
  fs.symlinkSync(copy, link, 'junction');   // a junction on Windows (no admin rights needed), a symlink elsewhere
  try {
    const viaLink = (script, args) => spawnSync(process.execPath, [path.join(link, 'scripts', script), '--project', dir, ...args], { cwd: dir, encoding: 'utf8', input: '' });
    const inv = viaLink('inventory.mjs', []);
    assert(inv.status === 0 && inv.stdout.includes('Project:') && inv.stdout.includes('drafts/ch3.md'), `inventory through a link: ${JSON.stringify(inv.stdout)} ${inv.stderr}`);
    const cite = viaLink('cite-check.mjs', ['drafts/ch3.md']);
    assert(cite.status === 0 && JSON.parse(cite.stdout).unresolved[0].key === 'smtih2020', `cite-check through a link: ${JSON.stringify(cite.stdout)} ${cite.stderr}`);
  } finally {
    fs.unlinkSync(link);
  }
});

test('pause tracker: idle time and paragraph ends count as pauses', () => {
  let t = 0;
  const tracker = new PauseTracker({ pauseMs: 8000, stuckMs: 180000, now: () => t });
  tracker.recordEdit(1, 0);
  t = 3000;
  assert(!tracker.isPaused(), 'not paused after 3s');
  t = 9000;
  assert(tracker.isPaused(), 'paused after 9s');
  tracker.recordEdit(1, 0, endsParagraph('It ended.', '\n'));
  assert(tracker.isPaused(), 'paragraph end is a pause');
});

test('pause tracker: mostly deleting for minutes reads as stalled; reading does not', () => {
  let t = 0;
  const reader = new PauseTracker({ stuckMs: 180000, now: () => t });
  t = 600000;
  assert(!reader.isStalled(), 'reading without writing is not a stall');
  t = 0;
  const tracker = new PauseTracker({ stuckMs: 180000, now: () => t });
  for (let i = 0; i < 40; i++) { t = i * 5000; tracker.recordEdit(i % 2 ? 0 : 5, i % 2 ? 6 : 0); }
  assert(tracker.isStalled(), 'write-delete churn should read as stalled');
});

test('pause tracker: back after more than a minute away starts a fresh clock; a glance away does not (B-15)', () => {
  let t = 0;
  const tracker = new PauseTracker({ stuckMs: 180000, now: () => t });
  tracker.recordEdit(5, 0);
  t = 120000; tracker.recordBlur();
  t = 720000;
  assert(tracker.recordFocus(), 'ten minutes away counts as coming back');
  assert(!tracker.isStalled() && tracker.idleMs() === 0, 'a fresh clock after coming back');
  t += 600000;
  assert(!tracker.isStalled(), 'reading after coming back is not a stall');
  tracker.recordEdit(5, 0);
  t += 150000; tracker.recordBlur();
  t += 20000;
  assert(!tracker.recordFocus(), 'twenty seconds away is a glance');
  t += 15000;
  assert(tracker.isStalled(), 'idle time from before a glance away still counts');
});

test('settings: suggestBreaks takes yes or no, storyLength flash, short or long; anything else is refused and changes nothing', () => {
  const dir = project();
  setUp(dir);
  const before = fs.readFileSync(marginPath(dir, 'settings.json'), 'utf8');
  for (const [key, value, hint] of [['suggestBreaks', 'maybe', 'yes or no'], ['suggestBreaks', '', 'yes or no'], ['storyLength', 'epic', 'flash, short or long']]) {
    const r = run('settings.mjs', ['set', key, value], dir);
    assert(r.code === 1 && r.out.includes(hint) && r.out.includes('Nothing was changed'), `set ${key} "${value}": ${r.out}`);
  }
  assert(fs.readFileSync(marginPath(dir, 'settings.json'), 'utf8') === before, 'a refused value must not touch the file');
  run('settings.mjs', ['set', 'storyLength', 'Long'], dir);
  run('settings.mjs', ['set', 'suggestBreaks', 'Off'], dir);
  const show = run('settings.mjs', ['show'], dir).out;
  assert(show.includes('storyLength: long') && show.includes('suggestBreaks: false'), show);
  putMargin(dir, 'settings.json', JSON.stringify({ storyLength: 'epic' }));
  const shown = run('settings.mjs', ['show'], dir).out;
  assert(shown.includes('storyLength: short') && shown.includes('ignored storyLength: "epic" (expected flash, short or long)'), shown);
});

test('the pause skill reads storyLength from the settings and promises no saved place', () => {
  const text = fs.readFileSync(path.join(scripts, '..', 'skills', 'pause', 'SKILL.md'), 'utf8');
  assert(text.includes('settings.mjs" --project "${CLAUDE_PROJECT_DIR}" show') && text.includes('`storyLength` setting'), 'reads the setting');
  assert(!text.includes('place is saved'), 'Claude Code saves no place');
});

// K4: the break offer backs off by itself once it has been seen (A-15/B-14).
// Each call runs the offer second by second and returns a string with one
// letter per second: B shown, . hidden.
function offerTimeline(offer, clock, seconds, { wanted = true, focused = true, typeAt = [], clickAt = [] } = {}) {
  let out = '';
  for (let s = 0; s < seconds; s++) {
    clock.t += 1000;
    if (typeAt.includes(s)) offer.typed();
    if (clickAt.includes(s)) offer.clicked();
    out += offer.update(typeof wanted === 'function' ? wanted(s) : wanted, focused) ? 'B' : '.';
  }
  return out;
}
const runs = (line) => line.match(/B+|\.+/g).map((r) => `${r[0]}${r.length}`).join(' ');

test('break offer: shown while stalled, hides after 2 minutes unclicked, stays away 20 minutes, then returns', () => {
  const clock = { t: 0 };
  const offer = new BreakOffer({ now: () => clock.t });
  const line = runs(offerTimeline(offer, clock, 22 * 60 + 30));
  assert(line === 'B120 .1200 B30', line);
});

test('break offer: typing hides it once it has been seen (30 s), not before; a click snoozes at once', () => {
  let clock = { t: 0 };
  let offer = new BreakOffer({ now: () => clock.t });
  let line = runs(offerTimeline(offer, clock, 60, { typeAt: [10, 20, 40] }));
  assert(line === 'B40 .20', `typing at 10 s and 20 s (not yet seen), then at 40 s: ${line}`);
  assert(runs(offerTimeline(offer, clock, 20 * 60)) === '.1180 B20', 'snoozed for 20 minutes after typing');
  clock = { t: 0 };
  offer = new BreakOffer({ now: () => clock.t });
  line = runs(offerTimeline(offer, clock, 21 * 60, { clickAt: [5] }));
  assert(line === 'B5 .1200 B55', `clicked at 5 s: ${line}`);
});

test('break offer: never shown or counted while the window is unfocused; a stall that ends unseen starts afresh', () => {
  const clock = { t: 0 };
  const offer = new BreakOffer({ now: () => clock.t });
  assert(runs(offerTimeline(offer, clock, 600, { focused: false })) === '.600', 'unfocused');
  // Shown 20 s, the stall ends (not seen: no snooze), comes back: shown again for the full 2 minutes.
  const line = runs(offerTimeline(offer, clock, 200, { wanted: (s) => s < 20 || s >= 30 }));
  assert(line === 'B20 .10 B120 .50', line);
});

// --- The VS Code companion, run unchanged against a mock of the VS Code API (A-33) ---

const { createWorld, EXTENSION_DIR } = require('./vscode-mock.cjs');

async function atest(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

const companionNote = (id, file, line, kind = 'citation') => ({ id, file, line, kind, message: `Note ${id}.`, status: 'open' });
function writeNotes(dir, notes) {
  fs.mkdirSync(path.join(dir, '.margin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.margin', 'suggestions.json'), JSON.stringify({ version: 1, items: notes }));
}
// Runs fn(world, dir) with the companion active in a fresh project; the fake
// clock is always put back.
async function withCompanion({ notes = [], settings, docs, config } = {}, fn) {
  const dir = project();
  writeNotes(dir, notes);
  if (settings) fs.writeFileSync(path.join(dir, '.margin', 'settings.json'), JSON.stringify(settings));
  const world = createWorld({ root: dir, docs, config });
  try {
    world.activate();
    await fn(world, dir);
  } finally {
    world.dispose();
  }
}

await atest('companion: activates, registers every command it contributes, and reads only settings it declares', () => withCompanion({}, (world) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(EXTENSION_DIR, 'package.json'), 'utf8'));
  const contributed = pkg.contributes.commands.map((c) => c.command).sort();
  assert(JSON.stringify(Object.keys(world.commands).sort()) === JSON.stringify(contributed), `registered ${Object.keys(world.commands)}, contributed ${contributed}`);
  world.tick(5);
  const declared = Object.keys(pkg.contributes.configuration.properties);
  const undeclared = [...world.log.settingsRead].filter((k) => !declared.includes(k) && k !== 'margin.stuckMinutes'); // the old name of quietMinutes, read only as a fallback
  assert(world.log.settingsRead.size && !undeclared.length, `undeclared settings read: ${undeclared}`);
}));

await atest('companion: a queued note waits for a pause, then shows as a dot on its line, in its own file only', () =>
  withCompanion({ notes: [companionNote('n1', 'drafts/ch3.md', 5)], docs: ['drafts/ch3.md', 'notes/interviews.md'] }, (world) => {
    const [draft, notes] = world.editors;
    for (let i = 0; i < 4; i++) { world.type('a'); world.tick(3); }
    assert(!world.dots(draft).length, 'a note must wait while the writer is typing');
    assert(/1 held until your next pause/.test(world.status.tooltip), world.status.tooltip);
    world.tick(9);
    assert(JSON.stringify(world.dots(draft)) === '[4]', `dots in the draft: ${world.dots(draft)}`);
    assert(!world.dots(notes).length, 'no dot in another file');
    assert(world.status.text === '$(circle-small-filled) Margin · 1', world.status.text);
  }));

// K5: nothing is sent to the editor or the status bar unless it changed.
await atest('companion: nothing is repainted or rewritten while nothing changes, idle or typing (K5)', () =>
  withCompanion({ notes: [companionNote('n1', 'drafts/ch3.md', 5), companionNote('n2', 'drafts/ch3.md', 9, 'related')], docs: ['drafts/ch3.md', 'notes/interviews.md'] }, (world) => {
    world.tick(10);
    assert(world.dots(world.editors[0]).length === 2, 'both notes shown');
    const before = { ...world.log };
    world.tick(60);
    for (let i = 0; i < 30; i++) { world.type('word '); world.tick(1); }
    world.tick(60);
    const calls = world.log.setDecorations - before.setDecorations;
    const writes = world.log.statusWrites - before.statusWrites;
    assert(calls === 0 && writes === 0, `over 150 s with nothing new: ${calls} setDecorations calls, ${writes} status writes`);
  }));

await atest('companion: revealing a note paints only the decoration it changes; an editor shown again gets its dots back', () =>
  withCompanion({ notes: [companionNote('n1', 'drafts/ch3.md', 5)], docs: ['drafts/ch3.md', 'notes/interviews.md'] }, (world, dir) => {
    world.tick(10);
    let before = world.log.setDecorations;
    writeNotes(dir, [companionNote('n1', 'drafts/ch3.md', 5), companionNote('n2', 'drafts/ch3.md', 12, 'contradiction')]);
    world.fileChanged('.margin/suggestions.json');
    world.tick(10);
    assert(world.log.setDecorations - before === 1, `one new contradiction note: ${world.log.setDecorations - before} setDecorations calls`);
    assert(JSON.stringify(world.dots(world.editors[0])) === '[4,11]', `dots: ${world.dots(world.editors[0])}`);
    before = world.log.setDecorations;
    const again = world.open('drafts/ch3.md');
    world.tick(1);
    assert(JSON.stringify(world.dots(again)) === '[4,11]' && world.log.setDecorations - before === 2, `reopened editor: dots ${world.dots(again)}, ${world.log.setDecorations - before} calls`);
  }));

// Samples the status bar every `step` seconds: B while it offers a break.
function statusTimeline(world, seconds, step = 10) {
  let out = '';
  for (let s = 0; s < seconds; s += step) { world.tick(step); out += world.status.text.includes('break?') ? 'B' : '.'; }
  return runs(out);
}

await atest('companion: an ignored break offer goes after 2 minutes and stays away 20; typing after seeing it does too (K4)', () =>
  withCompanion({}, (world) => {
    world.type('a');
    // Stalled from 3:00: shown 3:00-5:00, away until 25:00, shown again to 27:00.
    const line = statusTimeline(world, 30 * 60);
    assert(line === '.17 B12 .120 B12 .19', `every 10 s for 30 minutes: ${line}`);
  }).then(() => withCompanion({}, (world) => {
    world.type('a');
    world.tick(3 * 60 + 40);
    assert(world.status.text.includes('break?'), 'offered after the stall');
    world.type('b');
    world.tick(1);
    assert(!world.status.text.includes('break?'), 'typing after seeing it hides it');
    const line = statusTimeline(world, 21 * 60);
    assert(line === '.119 B7', `after typing, every 10 s for 21 minutes (back exactly 20 minutes after the keystroke): ${line}`);
  })));

await atest('companion: no break offer greets a writer back from more than a minute away (B-15)', () =>
  withCompanion({}, (world) => {
    world.type('a');
    world.tick(120);
    world.focus(false);
    world.tick(600);
    world.focus(true);
    const line = statusTimeline(world, 10 * 60);
    assert(line === '.60', `back after 10 minutes away, then reading, every 10 s for 10 minutes: ${line}`);
    world.type('b');
    const again = statusTimeline(world, 4 * 60);
    assert(again === '.17 B7', `writing again, then 3 minutes idle: ${again}`);
  }));

await atest('companion: "suggest breaks: no" from setup turns the offer off, and a change applies without a reload (A-16/B-21)', () =>
  withCompanion({ settings: { suggestBreaks: false } }, (world, dir) => {
    world.type('a');
    world.tick(4 * 60);
    assert(!world.status.text.includes('break?'), 'no offer while the project says no');
    fs.writeFileSync(marginPath(dir, 'settings.json'), JSON.stringify({ suggestBreaks: true }));
    world.fileChanged('.margin/settings.json');
    world.tick(1);
    assert(world.status.text.includes('break?'), 'offered once the project says yes');
    fs.writeFileSync(marginPath(dir, 'settings.json'), JSON.stringify({ suggestBreaks: false }));
    world.fileChanged('.margin/settings.json');
    world.tick(1);
    assert(!world.status.text.includes('break?'), 'gone again once it says no');
  }));

// The break menu's place-keeping: the spot where the writer was is highlighted
// when they come back, and never later than that.
async function chooseBreak(world, choice) {
  world.answer(choice);
  await world.run('margin.breakMenu');
}
await atest('companion: after a walk the writer\'s place is highlighted on return, unless they edited first or 30 minutes passed (A-22)', async () => {
  await withCompanion({}, async (world) => {
    await chooseBreak(world, 'walk');
    world.focus(false); world.tick(5 * 60); world.focus(true);
    await world.settle();
    const [editor] = world.editors;
    assert(world.log.shown.join() === 'drafts/ch3.md' && JSON.stringify(world.highlighted(editor)) === '[10]', `back from the walk: shown ${world.log.shown}, highlighted ${world.highlighted(editor)}`);
    world.tick(6);
    assert(!world.highlighted(editor).length, 'the highlight fades after 5 s');
  });
  await withCompanion({}, async (world) => {
    await chooseBreak(world, 'walk');
    world.type('x');
    world.tick(2 * 60 * 60);
    world.focus(false); world.tick(10); world.focus(true);
    await world.settle();
    assert(!world.log.shown.length, `kept writing instead, then switched apps two hours later: shown ${world.log.shown}`);
  });
  await withCompanion({}, async (world) => {
    await chooseBreak(world, 'walk');
    world.focus(false); world.tick(31 * 60); world.focus(true);
    await world.settle();
    assert(!world.log.shown.length, `back after 31 minutes: shown ${world.log.shown}`);
  });
  await withCompanion({}, async (world) => {
    await chooseBreak(world, 'quiet');
    world.focus(false); world.tick(60); world.focus(true);
    await world.settle();
    assert(!world.log.shown.length, 'switching apps during a quiet break shows nothing');
    world.log.panels[0].dispose();
    await world.settle();
    assert(world.log.shown.join() === 'drafts/ch3.md', `closing the quiet panel: shown ${world.log.shown}`);
  });
});

// A-24: note files are matched as the drive matches them.
test('a queued note keeps the file name as it is on disk; a file that doesn\'t exist yet keeps what was typed (A-24)', () => {
  const dir = project();
  const add = run('suggestions.mjs', ['add', '--file', 'DRAFTS/CH3.MD', '--line', '1', '--message', 'x', '--file', 'drafts/New.md', '--message', 'y'], dir);
  const files = JSON.parse(fs.readFileSync(marginPath(dir, 'suggestions.json'), 'utf8')).items.map((i) => i.file);
  const ignoresCase = fs.existsSync(path.join(dir, 'DRAFTS', 'CH3.MD'));
  assert(add.code === 0 && files[0] === (ignoresCase ? 'drafts/ch3.md' : 'DRAFTS/CH3.MD') && files[1] === 'drafts/New.md', `${add.out} ${JSON.stringify(files)}`);
});

await atest('companion: a note matches its file whatever the case on Windows and macOS, and only notes whose file exists are counted (A-24)', () =>
  withCompanion({ notes: [companionNote('n1', 'Drafts/Ch3.md', 3), companionNote('n2', 'drafts/gone.md', 2)] }, (world) => {
    world.tick(10);
    const ignoresCase = process.platform === 'win32' || process.platform === 'darwin';
    const dots = JSON.stringify(world.dots(world.editors[0]));
    assert(dots === (ignoresCase ? '[2]' : '[]'), `dots: ${dots}`);
    assert(world.status.text === (ignoresCase ? '$(circle-small-filled) Margin · 1' : '$(circle-small) Margin'), `status: ${world.status.text}`);
  }));

// B-05: Claude's file tools can't change Margin's own files.
test('Edit, Write and NotebookEdit into .margin are denied, except the organize plan (B-05)', () => {
  const dir = project();
  run('focus.mjs', ['add', 'drafts'], dir);
  setUp(dir);
  for (const tool of ['Edit', 'Write']) {
    for (const name of ['focus.json', 'settings.json', 'log.jsonl', 'history/x.md']) {
      const out = hook(dir, tool, { file_path: path.join(dir, '.margin', ...name.split('/')) }, 'toolu_b05');
      assert(out.out.includes('"deny"') && out.out.includes('/margin:focus'), `${tool} ${name}: ${out.out}`);
    }
  }
  assert(hook(dir, 'NotebookEdit', { notebook_path: path.join(dir, '.margin', 'focus.json') }, 'toolu_b05').out.includes('"deny"'), 'NotebookEdit should be denied');
  assert(hook(dir, 'Write', { file_path: path.join(dir, '.margin', 'plan.json') }, 'toolu_plan').out === '', 'the organize plan may be written');
  assert(hook(dir, 'Write', { file_path: path.join(dir, 'drafts', 'new.md') }, 'toolu_new').out === '', 'project files are unaffected');
  assert(JSON.parse(fs.readFileSync(marginPath(dir, 'focus.json'), 'utf8')).enabled === true, 'focus.json untouched');
  assert(run('focus.mjs', ['off'], dir).code === 0 && JSON.parse(fs.readFileSync(marginPath(dir, 'focus.json'), 'utf8')).enabled === false, 'Margin\u2019s own script still writes it');
});

// B-12: backup names are always valid, and a backup that fails is never silent.
test('backup names stay valid for another drive, odd characters and long names, and still end in the file name (B-12)', () => {
  const root = path.join(os.tmpdir(), 'margin test root');
  const cases = ['D:/writing/ch1.md', 'drafts/a:b?c*d"e<f>g|h.md', `drafts/${'x'.repeat(240)}.markdown`, '../outside/n.md', 'drafts/ends with dots...', 'drafts/' + '\u00e9\u00e8'.repeat(70) + '.md'];
  for (const c of cases) {
    const s = marginLib.newSnapshot(root, c);
    const name = path.basename(s.abs);
    assert(!/[<>:"/\\|?*\u0000-\u001f]/.test(name) && !/[. ]$/.test(name) && name.length <= 120, `${c} -> ${name}`);
  }
  assert(path.basename(marginLib.newSnapshot(root, `drafts/${'x'.repeat(240)}.markdown`).abs).endsWith('.markdown'), 'extension kept');
  // Two backups in the same millisecond never share a name.
  const dir = project();
  setUp(dir);
  const a = marginLib.newSnapshot(dir, 'drafts/ch3.md');
  fs.mkdirSync(path.dirname(a.abs), { recursive: true });
  fs.writeFileSync(a.abs, 'x');
  const b = marginLib.newSnapshot(dir, 'drafts/ch3.md');
  assert(a.abs !== b.abs, 'second name differs');
});

test('a backup with an odd name can be restored by undo, and an old-style backup name still works (B-12)', () => {
  const dir = project();
  setUp(dir);
  const odd = path.join(dir, 'drafts', 'odd: name?.md');
  const target = fs.existsSync(odd) ? odd : path.join(dir, 'drafts', 'odd name.md');
  fs.writeFileSync(target, 'before\n');
  hook(dir, 'Edit', { file_path: target }, 'toolu_odd');
  fs.writeFileSync(target, 'after\n');
  run('log-change.mjs', [], dir, { cwd: dir, tool_name: 'Edit', tool_input: { file_path: target }, tool_use_id: 'toolu_odd' });
  assert(run('review.mjs', ['undo', '1'], dir).code === 0 && fs.readFileSync(target, 'utf8') === 'before\n', 'undo restores');
});

test('if a backup can\u2019t be made the guard asks instead of crashing or staying silent (B-12)', () => {
  const dir = project();
  setUp(dir);
  const file = path.join(dir, 'drafts', 'ch3.md');
  const res = run('guard.mjs', [], dir, { cwd: dir, tool_name: 'Edit', tool_input: { file_path: file }, tool_use_id: 'toolu_fail', hook_event_name: 'PreToolUse' }, { MARGIN_TEST_FAIL: 'backup' });
  const out = JSON.parse(res.out).hookSpecificOutput;
  assert(res.code === 0 && out.permissionDecision === 'ask' && /back up drafts\/ch3\.md/.test(out.permissionDecisionReason) && /Allow it anyway/.test(out.permissionDecisionReason), res.out);
  assert(!fs.existsSync(marginPath(dir, 'history/pending/toolu_fail.json')), 'no pending record for a change that wasn\u2019t backed up');
  assert(fs.existsSync(marginPath(dir, 'errors.jsonl')), 'the failure is recorded');
});

// B-22: a relative Grep path means what the tool means: relative to its folder.
test('a relative Grep path is resolved against the hook’s folder, not the project root (B-22)', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, 'notes', 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes', 'drafts', 'x.md'), 'x\n');
  run('focus.mjs', ['add', 'drafts'], dir);
  const grep = (cwd, p) => run('guard.mjs', [], dir, { cwd, tool_name: 'Grep', tool_input: { pattern: 'x', path: p }, tool_use_id: 'toolu_g', hook_event_name: 'PreToolUse' }).out;
  assert(grep(path.join(dir, 'notes'), 'drafts').includes('"deny"'), 'notes/drafts is not in the focus list');
  assert(grep(path.join(dir, 'drafts'), '.') === '', 'the focused folder itself, searched from inside it');
  assert(grep(dir, 'drafts') === '', 'from the project root it still works');
  assert(grep(path.join(dir, 'drafts'), '..').includes('"deny"'), 'the parent of the focused folder is the whole project');
});

// A2-10: a Grep with no path searches the folder it runs in.
test('a Grep with no path is judged by the folder it runs in (A2-10)', () => {
  const dir = project();
  run('focus.mjs', ['add', 'drafts'], dir);
  const grep = (cwd) => run('guard.mjs', [], dir, { cwd, tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_use_id: 'toolu_g0', hook_event_name: 'PreToolUse' }).out;
  assert(grep(path.join(dir, 'drafts')) === '', 'inside the focused folder: allowed');
  assert(grep(path.join(dir, 'notes')).includes('"deny"'), 'in a folder outside the list: denied');
  assert(grep(dir).includes('"deny"'), 'at the project root: the whole project, denied');
});

// B-19: running /margin:check again must not repeat notes or revive dismissed ones.
test('a note that is already queued or dismissed is not added again, and the counts say so (B-19)', () => {
  const dir = project();
  const note = { file: 'drafts/ch3.md', line: 1, kind: 'citation', message: '@morrow2015 isn’t in your library.' };
  const first = run('suggestions.mjs', ['add', JSON.stringify([note, { ...note, kind: 'todo' }])], dir);
  assert(first.out.startsWith('2 new, 0 already queued or dismissed. 2 open in total.'), first.out);
  // Same file, kind and message, however it is spelled; the line may have moved.
  const again = run('suggestions.mjs', ['add', JSON.stringify({ ...note, line: 9, message: '  @Morrow2015   isn\'t in your library. ' })], dir);
  assert(again.out.startsWith('0 new, 1 already queued or dismissed. 2 open in total.'), again.out);
  const items = () => JSON.parse(fs.readFileSync(marginPath(dir, 'suggestions.json'), 'utf8')).items;
  assert(items().length === 2, `${items().length} items`);
  // Dismissed notes stay dismissed.
  run('suggestions.mjs', ['dismiss', items()[0].id], dir);
  const third = run('suggestions.mjs', ['add', JSON.stringify(note)], dir);
  assert(third.out.startsWith('0 new, 1 already queued or dismissed. 1 open in total.'), third.out);
  assert(items().filter((i) => i.status === 'dismissed').length === 1 && items().length === 2, 'the dismissed note was not revived');
  // A different message, or another file, is a new note; duplicates inside one command count once.
  const mixed = run('suggestions.mjs', ['add', '--file', 'drafts/ch3.md', '--kind', 'citation', '--message', 'Something else.', '--file', 'notes/interviews.md', '--kind', 'citation', '--message', note.message, '--file', 'notes/interviews.md', '--kind', 'citation', '--message', note.message], dir);
  assert(mixed.out.startsWith('2 new, 1 already queued or dismissed. 3 open in total.'), mixed.out);
  // Nothing new: the file isn't rewritten.
  const before = fs.statSync(marginPath(dir, 'suggestions.json')).mtimeMs;
  run('suggestions.mjs', ['add', JSON.stringify(note)], dir);
  assert(fs.statSync(marginPath(dir, 'suggestions.json')).mtimeMs === before, 'file left alone');
  // Only notes that were really added are counted: an invalid one is neither.
  const bad = run('suggestions.mjs', ['add', JSON.stringify([{ file: 'x.md' }, { file: 'drafts/ch3.md', message: 'fresh one' }])], dir);
  assert(bad.out.includes('Each note needs') && bad.out.includes('1 new, 0 already queued or dismissed.'), bad.out);
});

// A2-06: the same wording at different places stays separate notes; each stored note
// (queued or dismissed) absorbs only one repeat.
test('identical notes at different lines are each queued, and a re-run still adds nothing (A2-06)', () => {
  const dir = project();
  const tk = (...lines) => run('suggestions.mjs', ['add', ...lines.flatMap((l) => ['--file', 'drafts/ch3.md', '--line', String(l), '--kind', 'todo', '--message', 'Leftover TK marker.'])], dir);
  const items = () => JSON.parse(fs.readFileSync(marginPath(dir, 'suggestions.json'), 'utf8')).items;
  const first = tk(1, 3, 4);
  assert(first.out.startsWith('3 new, 0 already queued or dismissed. 3 open in total.'), first.out);
  assert(items().map((i) => i.line).join() === '1,3,4', `lines: ${items().map((i) => i.line)}`);
  const again = tk(1, 3, 4);
  assert(again.out.startsWith('0 new, 3 already queued or dismissed. 3 open in total.'), again.out);
  run('suggestions.mjs', ['dismiss', items()[1].id], dir);
  const third = tk(1, 3, 4);
  assert(third.out.startsWith('0 new, 3 already queued or dismissed. 2 open in total.') && items().filter((i) => i.status === 'dismissed').length === 1, third.out);
  // One more marker appears: only it is new, and the stored notes keep their places.
  const fourth = tk(1, 3, 4, 9);
  assert(fourth.out.startsWith('1 new, 3 already queued or dismissed. 3 open in total.') && items().map((i) => i.line).join() === '1,3,4,9', `${fourth.out} ${items().map((i) => i.line)}`);
});

test('the same finding worded differently, at the same line and source, is not added again (B2-09)', () => {
  const dir = project();
  const add = (message, extra = ['--line', '12', '--source', 'notes/interviews.md:40']) => run('suggestions.mjs', ['add', '--file', 'drafts/ch3.md', ...extra, '--kind', 'contradiction', '--message', message], dir);
  const items = () => JSON.parse(fs.readFileSync(marginPath(dir, 'suggestions.json'), 'utf8')).items;
  assert(add('Says 1871 here; notes/interviews.md:40 says 1874.').out.startsWith('1 new, 0 already queued or dismissed. 1 open in total.'), 'first run');
  const reworded = add('This says 1871, but notes/interviews.md:40 says 1874.');
  assert(reworded.out.startsWith('0 new, 1 already queued or dismissed. 1 open in total.') && items().length === 1, reworded.out);
  // Dismissed stays dismissed, reworded or not.
  run('suggestions.mjs', ['dismiss', items()[0].id], dir);
  assert(add('The year here is 1871; the interview says 1874.').out.startsWith('0 new, 1 already queued or dismissed. 0 open in total.'), 'dismissed, reworded');
  // A different line, a different source, no source, or another kind is a different finding.
  assert(add('A different line.', ['--line', '13', '--source', 'notes/interviews.md:40']).out.startsWith('1 new,'), 'other line');
  assert(add('A different source.', ['--line', '12', '--source', 'notes/interviews.md:41']).out.startsWith('1 new,'), 'other source');
  assert(add('No source at all.', ['--line', '12']).out.startsWith('1 new,'), 'no source');
  assert(add('No source at all.', ['--line', '12']).out.startsWith('0 new,'), 'no source: identical wording repeats');
  assert(add('No source, reworded.', ['--line', '12']).out.startsWith('1 new,'), 'no source: a reworded note is not matched');
  // Two different messages for one line and source in a single command are both kept.
  const both = run('suggestions.mjs', ['add', '--file', 'drafts/ch3.md', '--line', '30', '--kind', 'citation', '--source', 's.md:1', '--message', 'First thing.', '--file', 'drafts/ch3.md', '--line', '30', '--kind', 'citation', '--source', 's.md:1', '--message', 'Second thing.'], dir);
  assert(both.out.startsWith('2 new,'), both.out);
});

// B-28: one unreadable thing, a bad argument or a tools folder must not spoil the inventory.
test('inventory: a bad folder argument gets a clear message; a folder outside the project is refused (B-28)', () => {
  const dir = project();
  const missing = run('inventory.mjs', ['nope'], dir);
  assert(missing.code === 1 && /There is no folder "nope"/.test(missing.out) && !missing.err, `${missing.out} ${missing.err}`);
  const asFile = run('inventory.mjs', ['drafts/ch3.md'], dir);
  assert(asFile.code === 1 && /no folder/.test(asFile.out), asFile.out);
  const outside = run('inventory.mjs', ['..'], dir);
  assert(outside.code === 1 && /outside this project/.test(outside.out) && !outside.out.includes('Project:'), outside.out);
  assert(run('inventory.mjs', ['drafts'], dir).code === 0, 'a folder inside works');
});

test('inventory: tools folders (.venv, venv, __pycache__, dist, build, .idea) are skipped (B-28)', () => {
  const dir = project();
  for (const d of ['.venv', 'venv', '__pycache__', 'dist', 'build', '.idea']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.writeFileSync(path.join(dir, d, 'junk.txt'), 'x');
  }
  const out = run('inventory.mjs', [], dir).out;
  assert(!/junk\.txt/.test(out) && out.includes('drafts/ch3.md'), out);
});

test('inventory: a file that can’t be read is reported in one line and the rest still works (B-28)', () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'dup-a.md'), 'same text\n');
  fs.writeFileSync(path.join(dir, 'dup-b.md'), 'same text\n');
  const files = ['dup-a.md', 'dup-b.md', 'vanished.md'].map((p) => ({ full: path.join(dir, p), bytes: 10, path: p }));
  const errors = [];
  const groups = inventory.findDuplicates(files, { onError: (f) => errors.push(f.path) });
  assert(errors.join() === 'vanished.md', `errors: ${errors}`);
  assert(groups.length === 1 && groups[0].map((f) => f.path).join() === 'dup-a.md,dup-b.md', 'the readable pair is still found');
  // A folder that can't be opened (POSIX permissions; skipped where they don't apply).
  if (process.platform !== 'win32' && !(process.getuid && process.getuid() === 0)) {
    fs.mkdirSync(path.join(dir, 'locked'));
    fs.writeFileSync(path.join(dir, 'locked', 'a.md'), 'x');
    fs.chmodSync(path.join(dir, 'locked'), 0);
    try {
      const out = run('inventory.mjs', [], dir);
      assert(out.code === 0 && /Couldn't read 1 item\(s\): locked/.test(out.out) && out.out.includes('drafts/ch3.md'), out.out + out.err);
    } finally { fs.chmodSync(path.join(dir, 'locked'), 0o755); }
  }
});

// B-30: close matches are found faster, with exactly the same answers.
// The reference below is the original method: the full edit distance to every key.
function referenceClose(key, keys) {
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  return keys.map((k) => ({ k, d: dist(key.toLowerCase(), k.toLowerCase()) }))
    .filter((x) => x.d <= 3 || x.k.toLowerCase().startsWith(key.toLowerCase()))
    .sort((a, b) => a.d - b.d).slice(0, 3).map((x) => x.k);
}
function seededRandom(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function randomKeys(n, rand) {
  const parts = ['smith', 'jones', 'hale', 'morrow', 'okafor', 'lee', 'chen', 'garcia', 'muller', 'tide', 'mill', 'estuary'];
  const keys = new Set();
  while (keys.size < n) keys.add(parts[Math.floor(rand() * parts.length)] + (1990 + Math.floor(rand() * 35)) + (rand() < 0.4 ? ':' + parts[Math.floor(rand() * parts.length)] : '') + (rand() < 0.2 ? String.fromCharCode(97 + Math.floor(rand() * 26)) : ''));
  return [...keys];
}
function typo(key, rand) {
  const k = [...key];
  const edits = Math.floor(rand() * 5);
  for (let i = 0; i < edits; i++) {
    const at = Math.floor(rand() * k.length);
    const roll = rand();
    if (roll < 0.34) k.splice(at, 1); else if (roll < 0.67) k.splice(at, 0, 'x'); else k[at] = 'q';
  }
  return rand() < 0.2 ? k.join('').toUpperCase() : k.join('');
}

test('close matches are exactly what the full edit distance gives, for typos, prefixes, case and unrelated keys (B-30)', () => {
  const rand = seededRandom(7);
  const keys = randomKeys(300, rand);
  const find = citeCheck.closeKeyFinder(keys);
  const wanted = [];
  for (let i = 0; i < 400; i++) wanted.push(typo(keys[Math.floor(rand() * keys.length)], rand));
  wanted.push('smith', 'sm', 'zzzzzzzz', 'Smith1990', 'a', 'estuary20');   // prefixes, short, unrelated, other case
  for (const w of wanted) {
    if (keys.includes(w)) continue;
    assert(JSON.stringify(find(w)) === JSON.stringify(referenceClose(w, keys)), `${w}: ${find(w)} vs ${referenceClose(w, keys)}`);
  }
  assert(citeCheck.boundedDistance('kitten', 'sitten') === 1 && citeCheck.boundedDistance('abcdef', 'uvwxyz') === 4, 'bounded distance caps at max + 1');
});

test('close matches for a big library with repeated typos are much faster than the full distance (B-30)', () => {
  const rand = seededRandom(11);
  const keys = randomKeys(1500, rand);
  const typos = Array.from({ length: 40 }, () => typo(keys[Math.floor(rand() * keys.length)], rand) + 'zz');
  const occurrences = typos.flatMap((w) => [w, w, w]);   // each typo cited three times
  let t0 = process.hrtime.bigint();
  const find = citeCheck.closeKeyFinder(keys);
  const fast = occurrences.map((w) => find(w));
  const fastMs = Number(process.hrtime.bigint() - t0) / 1e6;
  t0 = process.hrtime.bigint();
  const slow = occurrences.map((w) => referenceClose(w, keys));
  const slowMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert(JSON.stringify(fast) === JSON.stringify(slow), 'same answers');
  // Measured against the old method on this very machine, so a slow machine doesn't fail it.
  assert(fastMs * 4 < slowMs, `new ${fastMs.toFixed(0)} ms vs old ${slowMs.toFixed(0)} ms`);
});

test('cite-check output is unchanged for the sample draft: close matches and their details (B-30)', () => {
  const dir = project();
  const report = JSON.parse(run('cite-check.mjs', ['drafts/ch3.md'], dir).out);
  assert(report.unresolved.length === 1 && report.unresolved[0].key === 'smtih2020' && report.unresolved[0].closeMatches.join() === 'smith2020' && report.unresolved[0].closeMatchDetails[0].title === 'Tide Mills', JSON.stringify(report.unresolved));
});

// B-27: settings take effect without a reload; dismissing a note replaces the file in one step.
await atest('companion: a change to pauseSeconds, quietMinutes or suggestBreaks takes effect without a reload (B-27)', () =>
  withCompanion({ notes: [companionNote('n1', 'drafts/ch3.md', 5)] }, (world) => {
    // pauseSeconds 8 -> 30: a note stays held through 12 quiet seconds, and shows after 30.
    world.changeSetting('pauseSeconds', 30);
    world.type('a'); world.tick(12);
    assert(!world.dots().length, 'still held at 12 s with a 30 s pause');
    world.tick(20);
    assert(JSON.stringify(world.dots()) === '[4]', `shown after 30 s: ${world.dots()}`);
    // quietMinutes 3 -> 1: the break offer appears after one quiet minute instead of three.
    world.changeSetting('quietMinutes', 1);
    world.type('a'); world.tick(40);
    assert(!/break\?/.test(world.status.text), 'not yet after 40 s');
    world.tick(40);
    assert(/break\?/.test(world.status.text), `offered after a minute: ${world.status.text}`);
    // suggestBreaks off: the offer goes away at once.
    world.changeSetting('suggestBreaks', false);
    world.tick(1);
    assert(!/break\?/.test(world.status.text), `no offer once breaks are off: ${world.status.text}`);
    // A nonsense value falls back to the default instead of breaking the timing.
    world.changeSetting('suggestBreaks', true);
    world.changeSetting('pauseSeconds', 'soon');
    world.changeSetting('quietMinutes', -4);
    world.type('a'); world.tick(9);
    assert(!/break\?/.test(world.status.text), 'default timings after nonsense values');
    world.tick(200);
    assert(/break\?/.test(world.status.text), 'default 3 minutes still offers a break');
  }));

// A2-08/B2-13: the setting was renamed from stuckMinutes to quietMinutes; the old key still works.
await atest('companion: a writer who only set the old margin.stuckMinutes keeps their value; quietMinutes wins when both are set (A2-08)', async () => {
  await withCompanion({ config: { stuckMinutes: 1 } }, (world) => {
    world.type('a'); world.tick(40);
    assert(!/break?/.test(world.status.text), 'not yet after 40 s');
    world.tick(40);
    assert(/break?/.test(world.status.text), `the old key still sets one minute: ${world.status.text}`);
  });
  await withCompanion({}, (world) => {
    // Changed while running: the old key applies without a reload too, until the new key has a value.
    world.changeSetting('stuckMinutes', 1);
    world.type('a'); world.tick(80);
    assert(/break?/.test(world.status.text), `old key changed while running: ${world.status.text}`);
  });
  await withCompanion({ config: { stuckMinutes: 1, quietMinutes: 5 } }, (world) => {
    world.type('a'); world.tick(80);
    assert(!/break?/.test(world.status.text), 'the new key wins over the old one');
    world.tick(240);
    assert(/break?/.test(world.status.text), 'and offers after its five minutes');
  });
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'vscode-extension', 'package.json'), 'utf8')).contributes.configuration.properties;
  assert(pkg['margin.quietMinutes'] && !pkg['margin.stuckMinutes'], 'package.json declares quietMinutes only');
});

await atest('companion: dismissing a note re-reads the file, keeps notes added meanwhile, and leaves no temp file (B-27)', () =>
  withCompanion({ notes: [companionNote('n1', 'drafts/ch3.md', 5), companionNote('n2', 'drafts/ch3.md', 9)] }, async (world, dir) => {
    world.tick(10);
    // Claude queues another note after the companion last read the file, before the writer dismisses n1.
    writeNotes(dir, [companionNote('n1', 'drafts/ch3.md', 5), companionNote('n2', 'drafts/ch3.md', 9), companionNote('n3', 'drafts/ch3.md', 12)]);
    world.answer((items) => items.find((i) => i.note && i.note.id === 'n1'), 'Dismiss');
    await world.run('margin.notes');
    await world.settle();
    const file = path.join(dir, '.margin', 'suggestions.json');
    const items = JSON.parse(fs.readFileSync(file, 'utf8')).items;
    assert(items.map((i) => `${i.id}:${i.status}`).join() === 'n1:dismissed,n2:open,n3:open', items.map((i) => `${i.id}:${i.status}`).join());
    assert(!fs.readdirSync(path.join(dir, '.margin')).some((n) => n.endsWith('.tmp')), 'no temp file left behind');
  }));

await atest('companion: a notes file that can’t be read is left untouched by a dismiss (B-27)', () =>
  withCompanion({ notes: [companionNote('n1', 'drafts/ch3.md', 5)] }, async (world, dir) => {
    world.tick(10);
    const file = path.join(dir, '.margin', 'suggestions.json');
    fs.writeFileSync(file, '{"version":1,"items":[{"id":"n1"');
    world.answer((items) => items[0], 'Dismiss');
    await world.run('margin.notes');
    await world.settle();
    assert(fs.readFileSync(file, 'utf8') === '{"version":1,"items":[{"id":"n1"', 'damaged file untouched');
    assert(!fs.readdirSync(path.join(dir, '.margin')).some((n) => n.endsWith('.tmp')), 'no temp file left behind');
  }));

// --- The shipped wiring (A-32): hooks.json and the skills, run the way Claude Code runs them ---
// Every command string comes from hooks.json or a SKILL.md as shipped, with
// ${CLAUDE_PLUGIN_ROOT} replaced by a copy of the plugin whose path has a space
// in it, and goes through `sh -c` in a project whose path has a space in it.

const hooksJson = JSON.parse(fs.readFileSync(path.join(scripts, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
const KNOWN_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'];
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const KNOWN_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'UserPromptSubmit'];

// The three wiring tests run hooks.json's command strings through `sh -c`, as Claude Code
// does where it has a Bash. Without an sh they are skipped with a clear message, not failed.
const hasSh = (() => { const r = spawnSync('sh', ['-c', 'echo hi'], { encoding: 'utf8', timeout: 20000 }); return !r.error && r.status === 0; })();
let skipped = 0;
function wiringTest(name, fn) {
  if (hasSh) return test(name, fn);
  skipped++;
  console.log(`skip ${name} (no sh on PATH; install Git for Windows)`);
}

// The hooks run on the Node that runs the tests. Its folder goes first on PATH, behind a
// `node` shim: Git's sh looks for a plain `node` file before `node.exe`, so it would
// otherwise pick another Node that is installed as a plain `node` further along the PATH.
let nodeShim = null;
function pathWithThisNode() {
  if (!nodeShim) {
    nodeShim = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-node-shim-'));
    made.push(nodeShim);
    fs.writeFileSync(path.join(nodeShim, 'node'), `#!/bin/sh
exec "${process.execPath.split(path.sep).join('/')}" "$@"
`, { mode: 0o755 });
  }
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  return { key, value: [nodeShim, path.dirname(process.execPath), process.env[key] || ''].filter(Boolean).join(path.delimiter) };
}

let pluginCopy = null;
function wiredPluginRoot() {
  if (!pluginCopy) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'margin plugin copy '));
    made.push(parent);
    pluginCopy = path.join(parent, 'margin plugin');
    fs.cpSync(path.join(scripts, '..'), pluginCopy, { recursive: true });
  }
  return fwdSlashes(pluginCopy);
}

const groupsFor = (event, tool) => (hooksJson[event] || []).filter((g) => g.matcher === undefined || new RegExp(`^(?:${g.matcher})$`).test(tool));

function shellCommand(command, dir, input) {
  const root = wiredPluginRoot();
  const res = spawnSync('sh', ['-c', command.split('${CLAUDE_PLUGIN_ROOT}').join(root)], {
    cwd: dir,
    input: input === undefined ? '' : JSON.stringify(input),
    env: { ...process.env, [pathWithThisNode().key]: pathWithThisNode().value, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: root },
    encoding: 'utf8',
    timeout: 20000
  });
  return { code: res.status, out: res.stdout, err: res.stderr, command };
}

// Runs every hook command hooks.json registers for this event and tool.
function wired(dir, event, tool, toolInput = {}, id = 'toolu_wired') {
  const runs = [];
  for (const group of groupsFor(event, tool)) {
    for (const h of group.hooks) {
      runs.push(shellCommand(h.command, dir, { session_id: 's', cwd: dir, hook_event_name: event, tool_name: tool, tool_input: toolInput, tool_use_id: id, prompt: 'Hello' }));
    }
  }
  return runs;
}
const wiredOk = (runs, label) => {
  assert(runs.length > 0, `${label}: hooks.json registers nothing for it`);
  for (const r of runs) assert(r.code === 0 && r.err === '', `${label}: exit ${r.code}, stderr ${JSON.stringify(r.err)} from ${r.command}`);
};
const wiredDecision = (runs) => runs.map((r) => (r.out.trim() ? JSON.parse(r.out).hookSpecificOutput.permissionDecision : 'allow')).find((d) => d !== 'allow') || 'allow';
const pendingIds = (dir) => (fs.existsSync(marginPath(dir, 'history/pending')) ? fs.readdirSync(marginPath(dir, 'history/pending')) : []);

wiringTest('hooks.json as shipped: every event works through sh, with spaces in the plugin and project paths (A-32)', () => {
  const dir = project();
  assert(dir.includes(' ') && wiredPluginRoot().includes(' '), 'both paths should contain a space');
  const wiredNode = shellCommand('node -p "process.version"', dir);
  assert(wiredNode.out.trim() === process.version, `wired hooks should run on the Node under test (${process.version}), not ${wiredNode.out.trim()}`);
  setUp(dir);
  run('focus.mjs', ['add', 'drafts'], dir);
  const file = path.join(dir, 'drafts', 'ch3.md');

  const read = wired(dir, 'PreToolUse', 'Read', { file_path: path.join(dir, 'notes', 'private.md') });
  wiredOk(read, 'Read');
  assert(wiredDecision(read) === 'deny', `a Read outside the list should be denied: ${read.map((r) => r.out)}`);
  assert(wiredDecision(wired(dir, 'PreToolUse', 'Read', { file_path: file })) === 'allow', 'a Read inside the list is allowed');
  assert(wiredDecision(wired(dir, 'PreToolUse', 'Grep', { pattern: 'mill' })) === 'deny', 'a whole-project Grep is denied');
  const bash = wired(dir, 'PreToolUse', 'Bash', { command: 'cat notes/private.md' });
  wiredOk(bash, 'Bash');
  assert(wiredDecision(bash) === 'deny', 'cat outside the list is denied');
  assert(wiredDecision(wired(dir, 'PreToolUse', 'PowerShell', { command: 'Get-Content notes\\private.md' })) === 'deny', 'Get-Content outside the list is denied');

  // An edit: backup before, log entry after.
  wiredOk(wired(dir, 'PreToolUse', 'Edit', { file_path: file }, 'toolu_a'), 'Edit before');
  assert(pendingIds(dir).includes('toolu_a.json') && backupFiles(dir).length === 1, 'the backup and its pending record should exist');
  fs.writeFileSync(file, 'changed\n');
  wiredOk(wired(dir, 'PostToolUse', 'Edit', { file_path: file }, 'toolu_a'), 'Edit after');
  const log = logEntries(dir);
  assert(log.length === 1 && log[0].file === 'drafts/ch3.md' && log[0].snapshot, JSON.stringify(log));
  assert(!pendingIds(dir).length, 'the pending record should be gone');

  // A failed and a refused edit leave nothing behind.
  for (const event of ['PostToolUseFailure', 'PermissionDenied']) {
    const id = `toolu_${event}`;
    wiredOk(wired(dir, 'PreToolUse', 'Edit', { file_path: file }, id), `${event}: before`);
    wiredOk(wired(dir, event, 'Edit', { file_path: file }, id), event);
    assert(!pendingIds(dir).length && backupFiles(dir).length === 1 && logEntries(dir).length === 1, `${event}: backups ${backupFiles(dir).length}, log ${logEntries(dir).length}`);
  }

  const prompt = wired(dir, 'UserPromptSubmit', undefined);
  wiredOk(prompt, 'UserPromptSubmit');
  assert(JSON.parse(prompt[0].out).hookSpecificOutput.additionalContext.includes('drafts'), prompt[0].out);
});

wiringTest('hooks.json lint: events and matchers name known tools, and each event’s script handles every one of them (A-32)', () => {
  for (const event of Object.keys(hooksJson)) assert(KNOWN_EVENTS.includes(event), `unknown hook event ${event}`);
  const scriptOf = (h) => /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([\w-]+\.mjs)"$/.exec(h.command);
  for (const [event, groups] of Object.entries(hooksJson)) {
    for (const group of groups) {
      if (group.matcher !== undefined) {
        const names = group.matcher.split('|');
        assert(new Set(names).size === names.length, `${event}: duplicate tool in ${group.matcher}`);
        for (const n of names) assert(KNOWN_TOOLS.includes(n), `${event}: matcher names an unknown tool ${n}`);
      }
      assert(group.hooks.length > 0, `${event}: a group with no hooks`);
      for (const h of group.hooks) {
        const m = scriptOf(h);
        assert(h.type === 'command' && m, `${event}: command should be node "\${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs": ${h.command}`);
        assert(fs.existsSync(path.join(scripts, m[1])), `${event}: ${m[1]} doesn't exist`);
        assert(Number.isFinite(h.timeout) && h.timeout > 0 && h.timeout <= 30, `${event}: ${m[1]} needs a sensible timeout`);
      }
    }
  }
  // The tools Margin backs up before an edit are the tools it logs after one.
  const toolsOf = (event) => new Set((hooksJson[event] || []).flatMap((g) => (g.matcher || '').split('|')));
  const backedUp = [...toolsOf('PreToolUse')].filter((t) => WRITE_TOOLS.includes(t)).sort().join();
  for (const event of ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']) {
    assert([...toolsOf(event)].sort().join() === backedUp, `${event} should cover ${backedUp}, covers ${[...toolsOf(event)].sort()}`);
  }

  // Each script, run as registered, does the right thing for every tool its matcher names.
  const dir = project();
  setUp(dir);
  run('focus.mjs', ['add', 'drafts'], dir);
  const file = path.join(dir, 'drafts', 'ch3.md');
  const inputFor = (tool) => (tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file });
  let n = 0;
  for (const [event, groups] of Object.entries(hooksJson)) {
    for (const group of groups) {
      for (const tool of group.matcher === undefined ? [undefined] : group.matcher.split('|')) {
        const label = `${event}/${tool}`;
        const id = `toolu_lint${n++}`;
        for (const h of group.hooks) {
          const script = scriptOf(h)[1];
          if (event === 'PreToolUse' && script === 'guard.mjs') {
            if (tool === 'Read') assert(wiredDecision(wired(dir, event, tool, { file_path: path.join(dir, 'notes', 'private.md') })) === 'deny', `${label} should deny a read outside the list`);
            else if (tool === 'Grep') assert(wiredDecision(wired(dir, event, tool, { pattern: 'x' })) === 'deny', `${label} should deny a whole-project search`);
            else {
              assert(WRITE_TOOLS.includes(tool), `${label}: guard.mjs has no test for this tool`);
              wiredOk(wired(dir, event, tool, inputFor(tool), id), label);
              assert(pendingIds(dir).includes(`${id}.json`), `${label} should record a backup before the change`);
              wiredOk(wired(dir, 'PostToolUse', tool, inputFor(tool), id), `PostToolUse/${tool}`);
              assert(logEntries(dir).pop().tool === tool, `PostToolUse/${tool} should log the change as ${tool}`);
            }
          } else if (event === 'PreToolUse' && script === 'shell-guard.mjs') {
            const command = tool === 'PowerShell' ? 'Get-Content notes\\private.md' : 'cat notes/private.md';
            assert(wiredDecision(wired(dir, event, tool, { command })) === 'deny', `${label} should deny a read outside the list`);
          } else if (script === 'log-change.mjs' && event !== 'PostToolUse') {
            assert(WRITE_TOOLS.includes(tool), `${label}: log-change.mjs has no test for this tool`);
            wired(dir, 'PreToolUse', tool, inputFor(tool), id);
            assert(pendingIds(dir).includes(`${id}.json`), `${label}: setup should leave a pending record`);
            const before = logEntries(dir).length;
            wiredOk(wired(dir, event, tool, inputFor(tool), id), label);
            assert(!pendingIds(dir).includes(`${id}.json`) && logEntries(dir).length === before, `${label} should clear the pending record without logging`);
          } else if (script === 'log-change.mjs') {
            assert(WRITE_TOOLS.includes(tool), `${label}: log-change.mjs has no test for this tool`); // behavior checked with guard.mjs above
          } else if (event === 'UserPromptSubmit' && script === 'focus-context.mjs') {
            assert(tool === undefined, 'focus-context.mjs should run on every prompt');
            wiredOk(wired(dir, event, undefined), label);
          } else {
            assert(false, `${label}: no test for ${script}; add one to this lint`);
          }
        }
      }
    }
  }
});

wiringTest('skills lint: frontmatter parses, scripts exist, and every script command passes the project folder (A-32)', () => {
  const skillsDir = path.join(scripts, '..', 'skills');
  const names = fs.readdirSync(skillsDir).sort();
  assert(names.length >= 7, `expected the seven skills, found ${names}`);
  const readme = fs.readFileSync(path.join(here, '..', 'README.md'), 'utf8');
  const listed = [...readme.matchAll(/\|\s*`\/margin:(\w+)/g)].map((m) => m[1]).sort();
  assert(listed.join() === names.join(), `README commands ${listed} vs skills ${names}`);
  const runnable = new Set();
  for (const name of names) {
    const text = fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    assert(fm, `${name}: no frontmatter`);
    const meta = {};
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([\w-]+):\s*(.*)$/.exec(line);
      assert(m, `${name}: frontmatter line doesn't parse: ${line}`);
      meta[m[1]] = m[2];
    }
    assert(meta.name === name, `${name}: name is ${meta.name}`);
    assert(meta.description && meta.description.length > 40, `${name}: description is missing or too short`);
    assert(meta['allowed-tools'], `${name}: allowed-tools is missing`);
    assert(!('disable-model-invocation' in meta) || meta['disable-model-invocation'] === 'true', `${name}: disable-model-invocation should be true or absent`);
    for (const key of Object.keys(meta)) assert(['name', 'description', 'argument-hint', 'allowed-tools', 'disable-model-invocation'].includes(key), `${name}: unexpected frontmatter key ${key}`);
    if (meta['argument-hint']) assert(/^".*"$/.test(meta['argument-hint']), `${name}: quote the argument-hint`);
    for (const m of text.matchAll(/scripts\/([\w-]+\.mjs)/g)) assert(fs.existsSync(path.join(scripts, m[1])), `${name}: refers to a script that doesn't exist: ${m[1]}`);
    const commands = [...text.matchAll(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([\w-]+\.mjs)"([^`\n]*)/g)];
    if (commands.length) assert(meta['allowed-tools'].includes('Bash(node *)') && meta['allowed-tools'].includes('PowerShell(node *)'), `${name}: allow node in both shells`);
    for (const m of commands) {
      assert(m[2].startsWith(' --project "${CLAUDE_PROJECT_DIR}"'), `${name}: ${m[0]}`);
      if (!/[<$]/.test(m[2].slice(' --project "${CLAUDE_PROJECT_DIR}"'.length)) && /\s(show|init|ensure|status|list|undo)\s*$/.test(m[2])) runnable.add(m[0]);
    }
  }
  // The commands that need no input run as written.
  assert(runnable.size >= 6, `expected several argument-less commands, found ${[...runnable]}`);
  const dir = project();
  for (const command of runnable) {
    const r = shellCommand(command, dir); // sh expands ${CLAUDE_PROJECT_DIR} from the environment
    assert(r.code === 0 && r.err === '', `${command}: exit ${r.code} ${r.err}`);
  }
});

test('/margin:cite with no arguments picks the newest draft like /margin:check and says which (A-26)', () => {
  const skills = path.join(scripts, '..', 'skills');
  const cite = fs.readFileSync(path.join(skills, 'cite', 'SKILL.md'), 'utf8');
  const check = fs.readFileSync(path.join(skills, 'check', 'SKILL.md'), 'utf8');
  for (const [name, text] of [['check', check], ['cite', cite]]) {
    assert(/most recently changed file in the drafts folder/.test(text) && /say which one you picked/.test(text), `${name}: the no-argument rule is missing`);
    assert(text.includes('settings.mjs" --project "${CLAUDE_PROJECT_DIR}" show'), `${name}: the rule should read the drafts setting with settings show`);
  }
});

// --- Copy lint (A-27/B-25): nothing the writer can read tells them they are stuck or have stalled ---
test('copy lint: no text the writer can read says they are stuck or stalled', () => {
  const repo = path.join(here, '..');
  const files = [
    'README.md',
    '.claude-plugin/marketplace.json',
    'plugins/margin/.claude-plugin/plugin.json',
    'vscode-extension/package.json',
    ...fs.readdirSync(path.join(repo, 'plugins', 'margin', 'skills')).map((n) => `plugins/margin/skills/${n}/SKILL.md`)
  ];
  // Internal names such as stuckMs stay: the patterns need a word boundary.
  const banned = /\b(?:stuck|unstuck|stall|stalls|stalled|stalling)\b/i;
  const phrases = /\bseems? (?:to be )?(?:stuck|stalled|struggling)\b|\byou(?:'|’)?(?:re| are| have been|'ve been) (?:stuck|stalled|struggling)\b/i;
  const check = (where, text) => {
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      assert(!banned.test(line) && !phrases.test(line), `${where}:${i + 1} blames the writer: ${line.trim()}`);
    }
  };
  for (const f of files) check(f, fs.readFileSync(path.join(repo, f), 'utf8'));
  // In the companion, only the strings it shows (not identifiers or comments).
  const shown = fs.readFileSync(path.join(repo, 'vscode-extension', 'extension.js'), 'utf8').match(/'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g) || [];
  check('vscode-extension/extension.js (strings)', shown.join('\n'));
  // The check itself catches the phrases it exists for.
  for (const bad of ['when you seem stuck', "you're stuck", 'you’ve been stuck a while', 'if you have stalled', 'a break when stuck', 'help getting unstuck']) {
    assert(banned.test(bad) || phrases.test(bad), `the lint should catch: ${bad}`);
  }
  assert(!banned.test('const stuckMs') && !banned.test('tracker.stuckMs'), 'internal names are allowed');
});

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
