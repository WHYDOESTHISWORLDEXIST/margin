// Keeping .margin/history/ to a sensible size, without hiding anything.
//
// Kept always: every backup younger than 30 days, and the earliest (the file as
// it was before Claude first changed it) and the newest backup of each file.
// Only when the folder passes 200 MB are the oldest other backups removed, oldest
// first, until it is under; if what is kept always is larger, it stays larger.
// A change whose backup was removed keeps its line in the log, marked
// pruned:<date>, so /margin:review still lists it and says why it can't be undone.
//
// Backups of edits that failed or were refused are removed right away
// (PostToolUseFailure / PermissionDenied), and any pending record older than a
// day (a declined permission prompt fires no event) is swept with its backup.
//
// Which file a backup belongs to comes from the log and the pending records,
// never from the backup's name. Only files inside .margin/history/ are removed.
import fs from 'node:fs';
import path from 'node:path';
import { marginDir, readJson, isPlainObject, readChanges, withLock, writeJsonlAtomic, logPath, fileKey, isInside, safeToolUseId } from './lib.mjs';

const DAY = 24 * 60 * 60 * 1000;
// The MARGIN_TEST_* variables exist for the tests only.
const fromEnv = (name, fallback) => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(v) && v >= 0 ? v : fallback;
};
export const LIMITS = {
  capBytes: fromEnv('MARGIN_TEST_HISTORY_CAP', 200 * 1024 * 1024),
  keepMs: fromEnv('MARGIN_TEST_HISTORY_DAYS', 30) * DAY,
  pendingMs: DAY
};

const historyDir = (root) => path.join(marginDir(root), 'history');
const pendingDir = (root) => path.join(historyDir(root), 'pending');

function removeBackup(root, relPath) {
  const abs = path.resolve(root, relPath);
  if (!isInside(abs, historyDir(root)) || isInside(abs, pendingDir(root))) return false;
  try {
    if (!fs.statSync(abs).isFile()) return false;
    fs.rmSync(abs, { force: true });
    return true;
  } catch {
    return false;
  }
}

function referencedBackups(root, changes) {
  const refs = new Map();
  for (const c of changes) if (typeof c.e.snapshot === 'string') refs.set(fileKey(root, c.e.snapshot), c);
  return refs;
}

// Drop a pending record and the backup it made, unless the log already uses that backup.
function dropPending(root, name, refs) {
  const file = path.join(pendingDir(root), name);
  const r = readJson(file);
  if (r.state === 'ok' && isPlainObject(r.value) && typeof r.value.snapshot === 'string' && !refs.has(fileKey(root, r.value.snapshot))) {
    removeBackup(root, r.value.snapshot);
  }
  fs.rmSync(file, { force: true });
}

// A tool call that failed, or that auto mode refused: its backup isn't needed.
export function discardPending(root, toolUseId) {
  if (!safeToolUseId(toolUseId)) return;
  const name = `${toolUseId}.json`;
  if (!fs.existsSync(path.join(pendingDir(root), name))) return;
  withLock(root, 'log', () => dropPending(root, name, referencedBackups(root, readChanges(root).changes)));
}

function sweepPending(root, now, refs) {
  let names = [];
  try { names = fs.readdirSync(pendingDir(root)); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let st;
    try { st = fs.statSync(path.join(pendingDir(root), name)); } catch { continue; }
    if (now - st.mtimeMs >= LIMITS.pendingMs) dropPending(root, name, refs);
  }
}

function pendingBackups(root) {
  const keys = new Set();
  let names = [];
  try { names = fs.readdirSync(pendingDir(root)); } catch { return keys; }
  for (const name of names) {
    const r = readJson(path.join(pendingDir(root), name));
    if (r.state === 'ok' && isPlainObject(r.value) && typeof r.value.snapshot === 'string') keys.add(fileKey(root, r.value.snapshot));
  }
  return keys;
}

function localDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function tidyHistory(root, now = Date.now()) {
  withLock(root, 'log', () => {
    const { log, changes } = readChanges(root);
    const refs = referencedBackups(root, changes);
    sweepPending(root, now, refs);

    let entries = [];
    try { entries = fs.readdirSync(historyDir(root), { withFileTypes: true }); } catch { return; }
    const files = [];
    for (const d of entries) {
      if (!d.isFile()) continue;
      const abs = path.join(historyDir(root), d.name);
      try { const st = fs.statSync(abs); files.push({ abs, key: fileKey(root, abs), size: st.size, mtimeMs: st.mtimeMs }); } catch { /* gone */ }
    }
    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= LIMITS.capBytes) return;

    const keep = pendingBackups(root);
    const byFile = new Map();
    for (const c of changes) {
      if (typeof c.e.snapshot !== 'string') continue;
      const time = Date.parse(c.e.time);
      if (Number.isFinite(time) && now - time < LIMITS.keepMs) keep.add(fileKey(root, c.e.snapshot));
      const k = fileKey(root, c.e.file);
      if (!byFile.has(k)) byFile.set(k, []);
      byFile.get(k).push(c);
    }
    for (const list of byFile.values()) {
      list.sort((a, b) => a.id - b.id);
      keep.add(fileKey(root, list[0].e.snapshot));
      keep.add(fileKey(root, list[list.length - 1].e.snapshot));
    }

    const ageOf = (f) => {
      const c = refs.get(f.key);
      const time = c ? Date.parse(c.e.time) : NaN;
      return Number.isFinite(time) ? time : f.mtimeMs;
    };
    const candidates = files.filter((f) => !keep.has(f.key)).sort((a, b) => ageOf(a) - ageOf(b));
    const cleared = localDate(now);
    let changedLog = false;
    for (const f of candidates) {
      if (total <= LIMITS.capBytes) break;
      if (!removeBackup(root, f.abs)) continue;
      total -= f.size;
      const c = refs.get(f.key);
      if (c) { c.e.snapshot = null; c.e.pruned = cleared; changedLog = true; }
    }
    if (changedLog) {
      for (const x of changes) if (!Number.isInteger(x.e.id)) x.e.id = x.id;
      writeJsonlAtomic(logPath(root), log.lines);
    }
  });
}
