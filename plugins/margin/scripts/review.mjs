// The "suggesting view" for Claude's own changes.
// Usage:
//   node review.mjs list [count]                most recent changes first
//   node review.mjs undo <number> [--go-ahead]  restore the file as it was before that change
// Undo never loses anything. It refuses (exit code 2) and explains when later
// changes to the same file, or edits made since Claude's change, would be rolled
// back too, unless told --go-ahead. When it does write, it first keeps the
// current version and logs the undo as a change of its own, which can be undone
// in turn. A file Claude created is moved to .margin/trash, never deleted.
import fs from 'node:fs';
import path from 'node:path';
import {
  projectDir, scriptArgs, marginDir, appendLine, writeJsonlAtomic, damagedLinesNote, readChanges, withLock,
  fingerprint, copyFileAtomic, newSnapshot, renameWithRetry, localTime, sameFile, logPath
} from './lib.mjs';

const root = projectDir();
const args = scriptArgs();
const command = args[0] || 'list';
const say = (line) => console.log(line);
const ids = (list) => list.map((c) => `#${c.id}`).join(', ');

function describe(e) {
  if (e.tool === 'undo') return `undid #${(e.undoes || []).join(', #')}`;
  return e.created ? 'created' : 'edited';
}

// Later changes to the same file that are still in effect. Undo entries don't
// count: they only brought back an earlier version, so going past them loses nothing.
function laterChanges(changes, c) {
  return changes.filter((o) => o.id > c.id && !o.e.undone && o.e.tool !== 'undo' && sameFile(root, o.e.file, c.e.file));
}

// The newest change to the file that is still in effect: the file should still
// match what it left behind, unless someone edited the file since.
function newestInEffect(changes, c) {
  return changes.filter((o) => !o.e.undone && sameFile(root, o.e.file, c.e.file)).reduce((a, b) => (b.id > a.id ? b : a), c);
}

function canUndo(changes, c) {
  const e = c.e;
  if (e.undone) return 'no';
  if (e.pruned) return `backup cleared ${e.pruned}`;
  if (!e.snapshot && !e.created) return 'no backup';
  return laterChanges(changes, c).length ? 'with later changes' : 'yes';
}

function list(count) {
  const { log, changes } = readChanges(root);
  const note = damagedLinesNote(log.bad, 'log.jsonl');
  if (!changes.length) {
    say('Claude has not changed any files yet.');
  } else {
    say('#\twhen\t\t\tchange\tfile\tcan undo');
    for (const c of [...changes].reverse().slice(0, count)) {
      say(`${c.id}\t${localTime(c.e.time)}\t${c.e.undone ? 'undone' : describe(c.e)}\t${c.e.file}\t${canUndo(changes, c)}`);
    }
  }
  if (note) say(note);
  return 0;
}

function undo(id, goAhead) {
  const { log, changes } = readChanges(root);
  const note = damagedLinesNote(log.bad, 'log.jsonl');
  const c = changes.find((x) => x.id === id);
  if (!c) { say(`No change #${id}.`); return 1; }
  const e = c.e;
  if (e.undone) { say(`Change #${id} was already undone.`); return 0; }
  if (e.pruned) { say(`The backup for change #${id} was cleared on ${e.pruned} to save space, so it can't be undone here.`); return 1; }
  const target = path.resolve(root, e.file);
  const snapshot = e.snapshot ? path.resolve(root, e.snapshot) : null;
  if (snapshot && !fs.existsSync(snapshot)) { say(`The backup for change #${id} is no longer there, so it can't be undone here.`); return 1; }
  if (!snapshot && !e.created) { say(`No backup exists for change #${id}, so it can't be undone here.`); return 1; }

  const now = fingerprint(target);
  const nextId = Math.max(log.lines.length, ...changes.map((x) => x.id)) + 1;
  const save = (extra) => {
    for (const x of changes) if (!Number.isInteger(x.e.id)) x.e.id = x.id; // pin older entries to their numbers
    writeJsonlAtomic(logPath(root), extra ? [...log.lines, { value: extra }] : log.lines);
  };

  if (!snapshot && now === 'absent') {
    e.undone = true;
    save();
    say(`${e.file} is already gone, so there was nothing to undo for change #${id}.`);
    return 0;
  }

  const later = laterChanges(changes, c);
  const newest = newestInEffect(changes, c);
  const changedSince = typeof newest.e.after === 'string' && now !== newest.e.after;
  if ((later.length || changedSince) && !goAhead) {
    if (later.length) {
      say(`Change #${id} (${describe(e)} ${e.file}, ${localTime(e.time)}) was followed by ${ids(later)} to the same file. Undoing #${id} would roll ${later.length === 1 ? 'that' : 'those'} back too. To undo only the latest, use: undo ${later[later.length - 1].id}`);
    }
    if (changedSince) {
      say(`${e.file} has changed since Claude's last recorded change to it (${now === 'absent' ? "it's no longer there" : 'probably your own writing'}). Undoing would replace that too.`);
    }
    say(`To go ahead anyway, run: undo ${id} --go-ahead. The current version is kept first, so this undo can be undone too.`);
    if (note) say(note);
    return 2;
  }

  // 1. Keep what's there now.
  let kept = null;
  if (now !== 'absent') {
    kept = newSnapshot(root, e.file);
    copyFileAtomic(target, kept.abs);
  }
  // 2. Bring back the earlier version (or move a file Claude created to the trash).
  if (snapshot) {
    copyFileAtomic(snapshot, target);
  } else {
    const trash = path.join(marginDir(root), 'trash', `${Date.now()}__${path.basename(target)}`);
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    renameWithRetry(target, trash);
  }
  // 3. Record it: this change and any later ones it rolled back are undone; if this
  //    was itself an undo, the changes it had undone are back in effect.
  for (const x of [c, ...later]) { x.e.undone = true; x.e.undoneBy = nextId; }
  if (e.tool === 'undo') for (const x of changes) if (x.e.undoneBy === id) { delete x.e.undone; delete x.e.undoneBy; }
  save({
    id: nextId,
    time: new Date().toISOString(),
    tool: 'undo',
    undoes: [id, ...later.map((x) => x.id)],
    file: e.file,
    created: kept === null,
    snapshot: kept ? kept.rel : null,
    after: fingerprint(target)
  });
  appendLine(path.join(marginDir(root), 'undo.jsonl'), { time: new Date().toISOString(), change: id, file: e.file });

  const rolled = later.length ? ` Later change${later.length === 1 ? '' : 's'} ${ids(later)} ${later.length === 1 ? 'was' : 'were'} rolled back too.` : '';
  const keptNote = kept ? ` The version it replaced is kept: undo ${nextId} brings it back.` : ` Undo ${nextId} puts it back.`;
  if (snapshot) say(`Restored ${e.file} to how it was before change #${id}.${rolled}${keptNote}`);
  else say(`Moved ${e.file} (which Claude created) to .margin/trash.${rolled}${keptNote}`);
  if (note) say(note);
  return 0;
}

if (command === 'list') {
  process.exit(list(Number(args[1]) || 20));
} else if (command === 'undo') {
  const goAhead = args.includes('--go-ahead');
  const idArg = args.slice(1).find((a) => a !== '--go-ahead');
  const id = Number(idArg);
  if (!Number.isInteger(id) || id < 1) { say(`No change #${idArg ?? ''}.`); process.exit(1); }
  process.exit(withLock(root, 'log', () => undo(id, goAhead)));
} else {
  say('Use "list" or "undo <number> [--go-ahead]".');
  process.exit(1);
}
