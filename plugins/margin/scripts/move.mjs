// Carry out an approved reorganization, safely and reversibly.
// Usage:
//   node move.mjs apply <plan.json>   plan = [{"from": "a.md", "to": "drafts/a.md"}, ...]
//   node move.mjs undo                puts back the most recent batch
// Never overwrites and never deletes. Every batch is logged in .margin/moves.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, marginDir, readJson, readJsonl, writeJsonlAtomic, damagedLinesNote, appendLine, rel, isInside } from './lib.mjs';

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
  const read = readJson(path.resolve(root, planFile || ''));
  if (read.state !== 'ok' || !Array.isArray(read.value)) {
    console.log(read.state === 'missing' ? 'Plan file not found.' : read.state === 'damaged' ? `The plan file is ${read.problem}.` : 'The plan file must be a JSON list of moves.');
    process.exit(1);
  }
  const plan = read.value;
  const done = [];
  for (const step of plan) {
    const problem = moveOne(step.from, step.to);
    if (problem) console.log(problem);
    else { done.push({ from: rel(root, step.from), to: rel(root, step.to) }); console.log(`moved ${step.from} -> ${step.to}`); }
  }
  if (done.length) appendLine(logFile, { time: new Date().toISOString(), moves: done });
  console.log(`${done.length} of ${plan.length} moved. Undo with: node move.mjs undo`);
} else if (command === 'undo') {
  const log = readJsonl(logFile);
  const note = damagedLinesNote(log.bad, 'moves.jsonl');
  const lastIndex = log.lines.map((l) => Boolean(l.value && Array.isArray(l.value.moves))).lastIndexOf(true);
  if (lastIndex < 0) { console.log('Nothing to undo.'); if (note) console.log(note); process.exit(0); }
  const last = log.lines[lastIndex].value;
  let restored = 0;
  for (const step of [...last.moves].reverse()) {
    const problem = moveOne(step.to, step.from);
    if (problem) console.log(problem); else restored++;
  }
  writeJsonlAtomic(logFile, log.lines.filter((_, i) => i !== lastIndex));
  console.log(`Put back ${restored} of ${last.moves.length} files from ${last.time}.`);
  if (note) console.log(note);
} else {
  console.log('Use "apply <plan.json>" or "undo".');
  process.exit(1);
}
