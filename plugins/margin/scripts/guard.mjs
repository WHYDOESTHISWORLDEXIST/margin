// PreToolUse hook.
// 1. Focus guard: while focus is on, Read and Grep only reach the files and
//    folders the writer picked with /margin:focus.
// 2. Safety net: before Claude writes or edits a file, save a copy so
//    /margin:review can show and undo the change.
// In a project where Margin isn't set up it does nothing and creates nothing,
// but a focus list that has been set is always enforced. If the focus list
// can't be understood, or this script itself fails, Claude's reads are paused
// (never its edits) with a message saying how to repair it.
import fs from 'node:fs';
import path from 'node:path';
import { readStdinJson, projectDir, marginDir, focusPath, isSetUp, readFocus, isInside, rel, writeJson, appendLine, newSnapshot, fileKey, realPath } from './lib.mjs';

const input = readStdinJson();
const root = projectDir(input);
const hasFocus = fs.existsSync(focusPath(root));
const setUp = isSetUp(root);
if (!hasFocus && !setUp) process.exit(0);

const tool = input.tool_name || '';
const args = input.tool_input || {};
const READ_TOOLS = ['Read', 'Grep'];

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
}

// Focus decisions compare real locations: a link (symlink or Windows junction)
// inside a focus folder can't reach outside it, and a path reached through a
// linked folder (like macOS's /var -> /private/var) still matches.
let realRootCache;
const realRoot = () => (realRootCache ??= realPath(root));

// Claude Code's own working files for this session: its scratchpad, and the
// folder next to the transcript where it saves long tool results for Claude to
// read back. Only outside the project, so they can never open a hole in it.
function sessionFolders() {
  const out = [];
  if (typeof input.scratchpad_dir === 'string' && input.scratchpad_dir.trim()) out.push(realPath(input.scratchpad_dir));
  if (typeof input.transcript_path === 'string' && /\.jsonl$/i.test(input.transcript_path)) {
    const t = path.resolve(input.transcript_path);
    out.push(realPath(path.join(path.dirname(t), path.basename(t).replace(/\.jsonl$/i, ''))));
  }
  return out.filter((dir) => !isInside(dir, realRoot()) && !isInside(realRoot(), dir));
}

// Always readable: the plugin's own files, the session folders above, and
// Margin's own files right inside .margin/ (settings, focus list, notes, logs).
// Not .margin/history/ or .margin/trash/: they hold copies of the writer's
// files, including ones outside the focus list.
function alwaysAllowed(real) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot && isInside(real, realPath(pluginRoot))) return true;
  if (sessionFolders().some((dir) => isInside(real, dir))) return true;
  if (fileKey(root, path.dirname(real)) !== fileKey(root, realPath(marginDir(root)))) return false;
  if (['history', 'trash'].includes(path.basename(real).toLowerCase())) return false;
  try { return !fs.statSync(real).isDirectory(); } catch { return true; }
}

function focusCheck(target, focus) {
  const real = realPath(target);
  if (alwaysAllowed(real)) return;
  const ok = focus.paths.some((p) => isInside(real, realPath(path.resolve(root, p))));
  if (ok) return;
  const list = focus.paths.length ? focus.paths.join(', ') : '(nothing picked yet)';
  if (!isInside(real, realRoot())) {
    deny(`Margin focus is on, and ${target} is outside this project. Claude can read only: ${list}. Ask the writer before going further.`);
  }
  deny(
    `Margin focus is on, and ${rel(root, target)} isn't in it. ` +
    `Claude can read only: ${list}. ` +
    `Ask the writer before going further. They can widen it with "/margin:focus add ${rel(root, target)}" or turn it off with "/margin:focus off".`
  );
}

function readTarget() {
  if (tool === 'Read' && args.file_path) return path.resolve(root, args.file_path);
  if (tool === 'Grep' && args.path) return path.resolve(root, args.path);
  return null;
}

function checkFocus() {
  if (!hasFocus || !READ_TOOLS.includes(tool)) return;
  const focus = readFocus(root);
  if (focus.state === 'damaged') {
    const target = readTarget();
    if (target && alwaysAllowed(realPath(target))) return;
    deny(
      `Margin's focus list (.margin/focus.json) is damaged (${focus.problem}), so reading files is paused to keep the writer's focus. ` +
      'Ask the writer to run /margin:focus status, which repairs it.'
    );
  }
  if (!focus.enabled) return;
  if (tool === 'Read' && args.file_path) focusCheck(readTarget(), focus);
  if (tool === 'Grep') {
    if (!args.path) {
      deny(`Margin focus is on, so searching the whole project is blocked. Search inside one of: ${focus.paths.join(', ') || '(nothing picked yet)'}.`);
    }
    focusCheck(readTarget(), focus);
  }
}

function backUp() {
  if (!setUp || !['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) return;
  const file = args.file_path || args.notebook_path;
  if (!file) return;
  const target = path.resolve(root, file);
  if (isInside(target, marginDir(root)) || !input.tool_use_id) return;
  const historyDir = path.join(marginDir(root), 'history');
  let snapshot = null;
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    snapshot = newSnapshot(root, rel(root, target));
    fs.mkdirSync(historyDir, { recursive: true });
    fs.copyFileSync(target, snapshot.abs);
  }
  writeJson(path.join(historyDir, 'pending', `${input.tool_use_id}.json`), {
    file: rel(root, target),
    snapshot: snapshot ? snapshot.rel : null,
    existed: Boolean(snapshot)
  });
}

try {
  if (process.env.MARGIN_TEST_FAIL === 'guard') throw new Error('simulated failure (test only)');
  checkFocus();
  backUp();
} catch (err) {
  // Never fail open without a trace: keep reads paused while a focus list
  // exists, record what went wrong, and let edits go ahead.
  if (setUp || fs.existsSync(marginDir(root))) {
    try { appendLine(path.join(marginDir(root), 'errors.jsonl'), { time: new Date().toISOString(), hook: 'guard', tool, error: String(err && err.message) }); } catch { /* nothing more to do */ }
  }
  if (hasFocus && READ_TOOLS.includes(tool)) {
    deny(`Margin's focus check hit an unexpected problem (${err && err.message}), so reading is paused to keep the writer's focus. Ask the writer to run /margin:focus status.`);
  }
}

process.exit(0);
