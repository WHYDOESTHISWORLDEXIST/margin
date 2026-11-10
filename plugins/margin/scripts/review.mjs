// The "suggesting view" for Claude's own changes.
// Usage:
//   node review.mjs list [count]     most recent changes first
//   node review.mjs undo <number>    restore the file as it was before that change
// Undo never deletes: a file Claude created is moved to .margin/trash instead.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, scriptArgs, marginDir, appendLine, readJsonl, writeJsonlAtomic, damagedLinesNote } from './lib.mjs';

const root = projectDir();
const logFile = path.join(marginDir(root), 'log.jsonl');
const log = readJsonl(logFile);
// A change's number is its line in the log, damaged lines included, so numbers
// never shift when a line can't be read.
const changes = log.lines.filter((l) => l.value).map((l) => ({ n: l.n, e: l.value }));
const damagedNote = damagedLinesNote(log.bad, 'log.jsonl');
const [command = 'list', arg] = scriptArgs();

if (command === 'list') {
  const count = Number(arg) || 20;
  if (!changes.length) {
    console.log('Claude has not changed any files yet.');
    if (damagedNote) console.log(damagedNote);
    process.exit(0);
  }
  console.log('#\twhen\t\t\tchange\tfile\tcan undo');
  [...changes].reverse().slice(0, count).forEach(({ n, e }) => {
    const what = e.undone ? 'undone' : e.created ? 'created' : 'edited';
    const undo = e.undone ? 'no' : e.snapshot || e.created ? 'yes' : 'no backup';
    const when = typeof e.time === 'string' ? e.time.slice(0, 16).replace('T', ' ') : '?';
    console.log(`${n}\t${when}\t${what}\t${e.file}\t${undo}`);
  });
  if (damagedNote) console.log(damagedNote);
} else if (command === 'undo') {
  const n = Number(arg);
  const found = changes.find((c) => c.n === n);
  if (!found) { console.log(`No change #${arg}.`); process.exit(1); }
  const entry = found.e;
  if (entry.undone) { console.log(`Change #${n} was already undone.`); process.exit(0); }
  const target = path.resolve(root, entry.file);
  if (entry.snapshot) {
    const snapshot = path.resolve(root, entry.snapshot);
    if (!fs.existsSync(snapshot)) { console.log(`The backup for change #${n} is no longer there, so it can't be undone here.`); process.exit(1); }
    fs.copyFileSync(snapshot, target);
    console.log(`Restored ${entry.file} to how it was before change #${n}.`);
  } else if (entry.created) {
    const trash = path.join(marginDir(root), 'trash', `${Date.now()}__${path.basename(target)}`);
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    if (fs.existsSync(target)) fs.renameSync(target, trash);
    console.log(`Moved ${entry.file} (which Claude created) to .margin/trash.`);
  } else {
    console.log(`No backup exists for change #${n}, so it can't be undone here.`);
    process.exit(1);
  }
  entry.undone = true;
  writeJsonlAtomic(logFile, log.lines);
  appendLine(path.join(marginDir(root), 'undo.jsonl'), { time: new Date().toISOString(), change: n, file: entry.file });
  if (changes.some((c) => c.n > n && c.e.file === entry.file && !c.e.undone)) {
    console.log('Note: later changes to the same file were rolled back too, because the file now matches the earlier backup.');
  }
  if (damagedNote) console.log(damagedNote);
} else {
  console.log('Use "list" or "undo <number>".');
  process.exit(1);
}
