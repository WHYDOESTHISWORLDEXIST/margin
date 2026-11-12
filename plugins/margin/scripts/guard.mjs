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
import { readStdinJson, projectDir, marginDir, focusPath, isSetUp, readFocus, focusRules, isInside, rel, writeJson, appendLine, newSnapshot, realPath, fileKey } from './lib.mjs';

const input = readStdinJson();
const root = projectDir(input);
const hasFocus = fs.existsSync(focusPath(root));
const setUp = isSetUp(root);
if (!hasFocus && !setUp) process.exit(0);

const tool = input.tool_name || '';
const args = input.tool_input || {};
const READ_TOOLS = ['Read', 'Grep'];
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

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

// Read and Grep only reach what the focus list allows (lib.focusRules, shared
// with the shell guard). A Grep without a path searches the whole project.
function checkFocus() {
  if (!hasFocus || !READ_TOOLS.includes(tool)) return;
  const focus = readFocus(root);
  if (focus.state === 'ok' && !focus.enabled) return;
  const rules = focusRules(root, input, focus);
  const reason = tool === 'Read'
    ? (args.file_path ? rules.reasonFor(path.resolve(root, args.file_path)) : null)
    : rules.searchReasonFor(args.path ? path.resolve(root, args.path) : root);
  if (reason) deny(reason);
}

// Margin's own files (focus list, settings, change log, backups) are changed
// through its commands, which run as node scripts. Editing them with Claude's
// file tools could switch focus off or damage the undo log without a trace. The
// one file a skill writes that way is the organize plan.
function protectMargin() {
  if (!EDIT_TOOLS.includes(tool)) return;
  const file = args.file_path || args.notebook_path;
  if (typeof file !== 'string' || !file) return;
  const target = path.resolve(root, file);
  if (!isInside(realPath(target), realPath(marginDir(root)))) return;
  if (fileKey(root, realPath(target)) === fileKey(root, realPath(path.join(marginDir(root), 'plan.json')))) return;
  deny("Margin's own files are changed with its commands (/margin:focus, /margin:review, /margin:setup), not edited directly. Ask the writer to run the command.");
}

function backUp() {
  if (!setUp || !EDIT_TOOLS.includes(tool)) return;
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
  protectMargin();
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
