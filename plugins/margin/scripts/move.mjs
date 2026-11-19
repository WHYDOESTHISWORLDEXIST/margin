// Carry out an approved reorganization, safely and reversibly.
// Usage:
//   node move.mjs apply <plan.json>   plan = [{"from": "a.md", "to": "drafts/a.md"}, ...]
//   node move.mjs undo                puts back the most recent batch
// Never overwrites and never deletes. Each move is logged in .margin/moves.jsonl
// the moment it happens, so a failure halfway can't leave a move unrecorded.
// It refuses to move the project folder, anything into itself, and anything in
// or into .git, .margin or node_modules.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, scriptArgs, marginDir, readJson, readJsonl, writeJsonlAtomic, damagedLinesNote, appendLine, rel, isInside, isPlainObject, localTime } from './lib.mjs';

const root = projectDir();
const logFile = path.join(marginDir(root), 'moves.jsonl');
const [command, planFile] = scriptArgs();
const PROTECTED = ['.git', '.margin', 'node_modules'];

function refusal(src, dest) {
  if (!isInside(src, root) || !isInside(dest, root)) return 'outside the project';
  if (isInside(root, src) || isInside(root, dest)) return "that's the project folder itself";
  for (const p of [src, dest]) {
    const parts = path.relative(root, p).split(path.sep).map((s) => s.toLowerCase());
    const hit = PROTECTED.find((name) => parts.includes(name));
    if (hit) return `Margin doesn't move things in or into ${hit}`;
  }
  if (isInside(dest, src)) return "a folder can't move into itself";
  return null;
}

function moveOne(from, to) {
  const src = path.resolve(root, from);
  const dest = path.resolve(root, to);
  const refused = refusal(src, dest);
  if (refused) return `skipped ${from}: ${refused}`;
  if (!fs.existsSync(src)) return `skipped ${from}: not found`;
  if (fs.existsSync(dest)) return `skipped ${from}: ${to} already exists`;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
  } catch (err) {
    const why = ['EBUSY', 'EPERM', 'EACCES'].includes(err.code)
      ? "it's open in another program, or Margin isn't allowed to move it"
      : `couldn't be moved (${err.code || err.message})`;
    return `skipped ${from}: ${why}`;
  }
  return null;
}

const validStep = (step) => isPlainObject(step) && typeof step.from === 'string' && step.from.trim() && typeof step.to === 'string' && step.to.trim();

if (command === 'apply') {
  const read = readJson(path.resolve(root, planFile || ''));
  if (read.state !== 'ok' || !Array.isArray(read.value)) {
    console.log(read.state === 'missing' ? 'Plan file not found.' : read.state === 'damaged' ? `The plan file is ${read.problem}.` : 'The plan file must be a JSON list of moves.');
    process.exit(1);
  }
  const plan = read.value;
  const time = new Date().toISOString();
  const batch = `${time}-${process.pid}`;
  let moved = 0;
  plan.forEach((step, i) => {
    if (!validStep(step)) { console.log(`skipped step ${i + 1}: it needs a "from" and a "to" path`); return; }
    const problem = moveOne(step.from, step.to);
    if (problem) { console.log(problem); return; }
    appendLine(logFile, { time, batch, moves: [{ from: rel(root, step.from), to: rel(root, step.to) }] });
    moved++;
    console.log(`moved ${step.from} -> ${step.to}`);
  });
  console.log(`${moved} of ${plan.length} moved.${moved ? ' To put them back: /margin:organize undo' : ''}`);
} else if (command === 'undo') {
  const log = readJsonl(logFile);
  const note = damagedLinesNote(log.bad, 'moves.jsonl');
  const isBatch = (l) => l.value && Array.isArray(l.value.moves);
  const keyOf = (l) => l.value.batch || `line ${l.n}`;
  const last = [...log.lines].reverse().find(isBatch);
  if (!last) { console.log('Nothing to undo.'); if (note) console.log(note); process.exit(0); }
  // The most recent batch: every recorded move with the same batch id.
  const lines = log.lines.filter((l) => isBatch(l) && keyOf(l) === keyOf(last));
  const steps = lines.flatMap((l) => l.value.moves);
  const failed = [];
  for (const step of [...steps].reverse()) {
    const problem = validStep(step) ? moveOne(step.to, step.from) : `skipped a damaged record`;
    if (problem) { console.log(problem); if (validStep(step)) failed.unshift(step); }
  }
  // Keep the steps that couldn't go back, so undo can be run again for them.
  const rest = log.lines.filter((l) => !lines.includes(l));
  if (failed.length) rest.push({ value: { time: last.value.time, batch: keyOf(last), moves: failed } });
  writeJsonlAtomic(logFile, rest);
  console.log(`Put back ${steps.length - failed.length} of ${steps.length} files moved at ${localTime(last.value.time)}.`);
  if (failed.length) console.log(`${failed.length} ${failed.length === 1 ? "file couldn't" : "files couldn't"} go back yet; once that's sorted out, /margin:organize undo puts ${failed.length === 1 ? 'it' : 'them'} back.`);
  if (note) console.log(note);
} else {
  console.log('Use "apply <plan.json>" or "undo".');
  process.exit(1);
}
