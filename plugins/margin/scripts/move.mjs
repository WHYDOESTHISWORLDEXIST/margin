// Carry out an approved reorganization, safely and reversibly.
// Usage:
//   node move.mjs apply <plan.json>   plan = [{"from": "a.md", "to": "drafts/a.md"}, ...]
//   node move.mjs undo                puts back the most recent batch
// Never overwrites and never deletes. Every batch is logged in .margin/moves.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, marginDir, readJson, appendLine, rel, isInside } from './lib.mjs';

const root = projectDir();
const logFile = path.join(marginDir(root), 'moves.jsonl');
const [command, planFile] = process.argv.slice(2);

function moveOne(from, to) {
  const src = path.resolve(root, from);
  const dest = path.resolve(root, to);
  if (!isInside(src, root) || !isInside(dest, root)) return `skipped ${from}: outside the project`;
  if (!fs.existsSync(src)) return `skipped ${from}: not found`;
  if (fs.existsSync(dest)) return `skipped ${from}: ${to} already exists`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return null;
}

if (command === 'apply') {
  const plan = readJson(path.resolve(root, planFile || ''), null);
  if (!Array.isArray(plan)) { console.log('Plan file missing or not a JSON list.'); process.exit(1); }
  const done = [];
  for (const step of plan) {
    const problem = moveOne(step.from, step.to);
    if (problem) console.log(problem);
    else { done.push({ from: rel(root, step.from), to: rel(root, step.to) }); console.log(`moved ${step.from} -> ${step.to}`); }
  }
  if (done.length) appendLine(logFile, { time: new Date().toISOString(), moves: done });
  console.log(`${done.length} of ${plan.length} moved. Undo with: node move.mjs undo`);
} else if (command === 'undo') {
  const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];
  if (!lines.length) { console.log('Nothing to undo.'); process.exit(0); }
  const last = JSON.parse(lines.pop());
  let restored = 0;
  for (const step of [...last.moves].reverse()) {
    const problem = moveOne(step.to, step.from);
    if (problem) console.log(problem); else restored++;
  }
  fs.writeFileSync(logFile, lines.length ? lines.join('\n') + '\n' : '');
  console.log(`Put back ${restored} of ${last.moves.length} files from ${last.time}.`);
} else {
  console.log('Use "apply <plan.json>" or "undo".');
  process.exit(1);
}
