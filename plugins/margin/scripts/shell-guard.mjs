// PreToolUse hook for Bash and PowerShell: keeps shell commands inside the focus
// list too. Exits at once unless a focus list is on (or damaged); only then is
// the command parsed (shell-check.mjs).
//   deny  a known reader (cat, head, grep, Get-Content, ...) names an existing file
//         outside the list, or a recursive search covers more than the list;
//   ask   an interpreter one-liner or an unknown program names an existing file
//         outside the list, or a reader's file can't be worked out ($VAR, a pipe);
//   allow everything else: listing names, echo/printf, Margin's own scripts.
// It never blocks a command because of its own failure: it asks instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStdinJson, projectDir, toolCwd, focusPath, marginDir, readFocus, focusRules, appendLine } from './lib.mjs';

const input = readStdinJson();
const root = projectDir(input);
if (!fs.existsSync(focusPath(root))) process.exit(0);
const focus = readFocus(root);
if (focus.state !== 'damaged' && !focus.enabled) process.exit(0);
const command = input.tool_input && input.tool_input.command;
if (typeof command !== 'string' || !command.trim()) process.exit(0);

function answer(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason }
  }));
  process.exit(0);
}

const rules = focusRules(root, input, focus);

try {
  if (process.env.MARGIN_TEST_FAIL === 'shell-guard') throw new Error('simulated failure (test only)');
  const { decide } = await import('./shell-check.mjs');
  const result = decide(command, {
    dialect: input.tool_name === 'PowerShell' ? 'powershell' : 'bash',
    cwd: toolCwd(input, root),
    scriptsDir: path.dirname(fileURLToPath(import.meta.url)),
    root,
    rules
  });
  if (result) answer(result.decision, result.reason);
} catch (err) {
  try { appendLine(path.join(marginDir(root), 'errors.jsonl'), { time: new Date().toISOString(), hook: 'shell-guard', error: String(err && err.message) }); } catch { /* nothing more to do */ }
  answer('ask', `Margin's focus check couldn't read this command (${err && err.message}). Allow it only if it stays within the focus list (${rules.list}).`);
}

process.exit(0);
