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
import { readStdinJson, projectDir, marginDir, focusPath, isSetUp, readFocus, isInside, rel, writeJson, appendLine } from './lib.mjs';

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

function alwaysAllowed(target) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  return isInside(target, marginDir(root)) || (pluginRoot && isInside(target, pluginRoot));
}

function focusCheck(target, focus) {
  if (alwaysAllowed(target)) return;
  const ok = focus.paths.some((p) => isInside(target, path.resolve(root, p)));
  if (!ok) {
    const list = focus.paths.length ? focus.paths.join(', ') : '(nothing picked yet)';
    deny(
      `Margin focus is on, and ${rel(root, target)} isn't in it. ` +
      `Claude can read only: ${list}. ` +
      `Ask the writer before going further. They can widen it with "/margin:focus add ${rel(root, target)}" or turn it off with "/margin:focus off".`
    );
  }
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
    if (target && alwaysAllowed(target)) return;
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
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    snapshot = path.join(historyDir, `${stamp}__${rel(root, target).replace(/\//g, '__')}`);
    fs.mkdirSync(historyDir, { recursive: true });
    fs.copyFileSync(target, snapshot);
  }
  writeJson(path.join(historyDir, 'pending', `${input.tool_use_id}.json`), {
    file: rel(root, target),
    snapshot: snapshot ? rel(root, snapshot) : null,
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
