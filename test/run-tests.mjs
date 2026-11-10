// Runs Margin's scripts against throwaway projects. No dependencies.
// Usage: node test/run-tests.mjs
import { spawnSync } from 'node:child_process';
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

function run(script, args, dir, input) {
  const res = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    cwd: dir,
    input: input ? JSON.stringify(input) : '',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: path.join(scripts, '..') },
    encoding: 'utf8'
  });
  return { out: res.stdout, err: res.stderr, code: res.status };
}

function hook(dir, tool, toolInput, id = 'toolu_1', script = 'guard.mjs') {
  return run(script, [], dir, { cwd: dir, tool_name: tool, tool_input: toolInput, tool_use_id: id, hook_event_name: 'PreToolUse' });
}

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
function claudeEdits(dir, rel, id, newText) {
  const file = path.join(dir, rel);
  hook(dir, 'Edit', { file_path: file }, id);
  fs.writeFileSync(file, newText);
  run('log-change.mjs', [], dir, { cwd: dir, tool_name: 'Edit', tool_input: { file_path: file }, tool_use_id: id });
}
const damagedCopies = (dir, name) => fs.readdirSync(path.join(dir, '.margin')).filter((f) => f.startsWith(`${name}.damaged-`));

test('a damaged log line is skipped and the next change is still logged on its own line', () => {
  const dir = project();
  putMargin(dir, 'log.jsonl', '{"time":"2026-11-10T10:00:00.000Z","tool":"Edit","file":"drafts/ch3.md","created":false,"snapshot":null}\n{"time":"2026-11-10T10:01:00.000Z","tool":"Ed');
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
  const file = path.join(dir, 'drafts/ch3.md');
  const before = fs.readFileSync(file, 'utf8');
  claudeEdits(dir, 'drafts/ch3.md', 'toolu_past_damage', 'changed\n');
  const undo = run('review.mjs', ['undo', '2'], dir);
  assert(undo.code === 0 && fs.readFileSync(file, 'utf8') === before, `undo #2 should restore the file: ${undo.out}${undo.err}`);
  assert(fs.readFileSync(marginPath(dir, 'log.jsonl'), 'utf8').startsWith('{"time":"2026-11-10T10:01:00.000Z","tool":"Ed\n'), 'the damaged line should be kept, not dropped');
});

test('undo explains a missing backup in one line', () => {
  const dir = project();
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
  shellRun('focus.mjs', ['add', 'ch3.md'], path.join(withGit, 'drafts'));
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
