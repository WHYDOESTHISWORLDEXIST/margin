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

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'margin-test-'));
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
