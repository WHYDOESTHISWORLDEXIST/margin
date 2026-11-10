// The "suggesting view" for Claude's own changes.
// Usage:
//   node review.mjs list [count]     most recent changes first
//   node review.mjs undo <number>    restore the file as it was before that change
// Undo never deletes: a file Claude created is moved to .margin/trash instead.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, marginDir, appendLine } from './lib.mjs';

const root = projectDir();
const logFile = path.join(marginDir(root), 'log.jsonl');
const entries = fs.existsSync(logFile)
  ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
const [command = 'list', arg] = process.argv.slice(2);

if (command === 'list') {
  const count = Number(arg) || 20;
  if (!entries.length) { console.log('Claude has not changed any files yet.'); process.exit(0); }
  console.log('#\twhen\t\t\tchange\tfile\tcan undo');
  entries.map((e, i) => ({ ...e, n: i + 1 })).reverse().slice(0, count).forEach((e) => {
    const what = e.undone ? 'undone' : e.created ? 'created' : 'edited';
    const undo = e.undone ? 'no' : e.snapshot || e.created ? 'yes' : 'no backup';
    console.log(`${e.n}\t${e.time.slice(0, 16).replace('T', ' ')}\t${what}\t${e.file}\t${undo}`);
  });
} else if (command === 'undo') {
  const n = Number(arg);
  const entry = entries[n - 1];
  if (!entry) { console.log(`No change #${arg}.`); process.exit(1); }
  if (entry.undone) { console.log(`Change #${n} was already undone.`); process.exit(0); }
  const target = path.resolve(root, entry.file);
  if (entry.snapshot) {
    fs.copyFileSync(path.resolve(root, entry.snapshot), target);
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
  fs.writeFileSync(logFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  appendLine(path.join(marginDir(root), 'undo.jsonl'), { time: new Date().toISOString(), change: n, file: entry.file });
  if (entries.slice(n).some((e) => e.file === entry.file && !e.undone)) {
    console.log('Note: later changes to the same file were rolled back too, because the file now matches the earlier backup.');
  }
} else {
  console.log('Use "list" or "undo <number>".');
  process.exit(1);
}
