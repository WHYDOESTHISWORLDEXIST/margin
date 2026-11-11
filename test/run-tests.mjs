// Runs Margin's scripts against throwaway projects. No dependencies.
// Usage: node test/run-tests.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..', 'plugins', 'margin', 'scripts');
const require = createRequire(import.meta.url);
const { PauseTracker, endsParagraph } = require('../vscode-extension/pause.js');

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

test('hooks started in a subfolder use the .margin of the project above it', () => {
  const dir = project();
  run('focus.mjs', ['add', 'drafts'], dir);
  const res = hookWithProjectDir(path.join(dir, 'drafts'), path.join(dir, 'drafts'), 'Read', { file_path: path.join(dir, 'notes/private.md') });
  assert(JSON.parse(res.out).hookSpecificOutput.permissionDecision === 'deny', `the root focus list should apply: ${res.out}${res.err}`);
  assert(marginDirsIn(dir).join() === '.', 'no .margin should appear in the subfolder');
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
