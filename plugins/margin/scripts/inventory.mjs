// Summarize a writing project's files so Claude can propose a tidy layout
// without opening every file.
// Usage: node inventory.mjs [folder]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { projectDir, scriptArgs, rel, isInside, realPath } from './lib.mjs';

// Folders that hold tools' files, not the writer's: skipped.
const SKIP = new Set(['.git', 'node_modules', '.margin', '.obsidian', '.vscode', '.trash', '.idea', '.venv', 'venv', '__pycache__', 'dist', 'build']);
const KINDS = {
  draft: ['.md', '.markdown', '.txt', '.docx', '.doc', '.tex', '.rtf', '.odt', '.fountain'],
  source: ['.pdf', '.epub', '.bib', '.ris', '.csl', '.html', '.htm'],
  data: ['.csv', '.xlsx', '.xls', '.json', '.tsv'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.heic']
};
const MAX_LIST = 300;
const HEAD = 64 * 1024;
const CHUNK = 1024 * 1024;

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  for (const [kind, exts] of Object.entries(KINDS)) if (exts.includes(ext)) return kind;
  return 'other';
}

// SHA-1 of the first `length` bytes of a file, read in 1 MB chunks.
function hashStart(file, length, onRead) {
  const h = crypto.createHash('sha1');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(length, 1)));
    for (let pos = 0; pos < length;) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, length - pos), pos);
      if (!n) break;
      h.update(buf.subarray(0, n));
      if (onRead) onRead(n, file);
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function groupBy(list, keyOf) {
  const groups = new Map();
  for (const item of list) {
    const k = keyOf(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(item);
  }
  return [...groups.values()];
}

// Groups of identical files ({ full, bytes } each), in the order the files were
// listed. Only files that share their size with another file are read at all:
// first their first 64 KB, then, if those match, the whole file. onRead(bytes,
// file) is told about every read (for tests). A file that can't be read is left
// out of the comparison and reported to onError(file, error).
export function findDuplicates(files, { onRead, onError } = {}) {
  const unreadable = new Set();
  const hash = (f, length) => {
    if (unreadable.has(f)) return 'unreadable:' + f.full;
    try { return hashStart(f.full, length, onRead); } catch (err) {
      unreadable.add(f);
      if (onError) onError(f, err);
      return 'unreadable:' + f.full; // alone in its group
    }
  };
  const order = new Map(files.map((f, i) => [f, i]));
  const groups = [];
  for (const sameSize of groupBy(files.filter((f) => f.bytes > 0), (f) => f.bytes)) {
    if (sameSize.length < 2) continue;
    for (const sameHead of groupBy(sameSize, (f) => hash(f, Math.min(HEAD, f.bytes)))) {
      if (sameHead.length < 2) continue;
      if (sameHead[0].bytes <= HEAD) { groups.push(sameHead); continue; }
      for (const same of groupBy(sameHead, (f) => hash(f, f.bytes))) if (same.length > 1) groups.push(same);
    }
  }
  const first = (g) => order.get(g[0]);
  return groups.map((g) => g.sort((a, b) => order.get(a) - order.get(b))).sort((a, b) => first(a) - first(b));
}

function main() {
  const root = projectDir();
  const asked = scriptArgs()[0];
  const start = path.resolve(root, asked || '.');
  if (!isInside(realPath(start), realPath(root))) {
    console.log(`"${asked}" is outside this project, so it isn't listed. Name a folder inside the project (the current one is ${root}).`);
    process.exit(1);
  }
  let startIsFolder = false;
  try { startIsFolder = fs.statSync(start).isDirectory(); } catch { /* handled below */ }
  if (!startIsFolder) {
    console.log(`There is no folder "${asked}" in this project. Name a folder (or leave it out to list the whole project).`);
    process.exit(1);
  }
  const files = [];
  const unreadable = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { unreadable.push(rel(root, dir)); return; }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        let stat;
        try { stat = fs.statSync(full); } catch { unreadable.push(rel(root, full)); continue; }
        files.push({ path: rel(root, full), kind: kindOf(full), bytes: stat.size, modified: stat.mtime.toISOString().slice(0, 10), full });
      }
    }
  })(start);

  const counts = {};
  for (const f of files) counts[f.kind] = (counts[f.kind] || 0) + 1;
  const folders = [...new Set(files.map((f) => path.posix.dirname(f.path)))].sort();

  console.log(`Project: ${rel(root, start)}  (${files.length} files)`);
  console.log(`By kind: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  console.log(`Folders: ${folders.join(', ') || '.'}`);
  const dupes = findDuplicates(files, { onError: (f) => unreadable.push(f.path) });
  if (dupes.length) {
    console.log('Identical files:');
    for (const group of dupes) console.log(`  - ${group.map((f) => f.path).join('  =  ')}`);
  }
  const empty = files.filter((f) => f.bytes === 0);
  if (empty.length) console.log(`Empty files: ${empty.map((f) => f.path).join(', ')}`);
  if (unreadable.length) console.log(`Couldn't read ${unreadable.length} item(s): ${[...new Set(unreadable)].slice(0, 5).join(', ')}${unreadable.length > 5 ? ', ...' : ''}`);
  console.log('');
  console.log('kind\tmodified\tKB\tpath');
  for (const f of files.slice(0, MAX_LIST)) {
    console.log(`${f.kind}\t${f.modified}\t${Math.ceil(f.bytes / 1024)}\t${f.path}`);
  }
  if (files.length > MAX_LIST) console.log(`... and ${files.length - MAX_LIST} more. Run again on a subfolder to see them.`);
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
if (process.platform === 'win32' ? invokedAs.toLowerCase() === self.toLowerCase() : invokedAs === self) main();
