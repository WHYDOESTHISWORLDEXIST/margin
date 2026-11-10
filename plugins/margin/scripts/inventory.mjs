// Summarize a writing project's files so Claude can propose a tidy layout
// without opening every file.
// Usage: node inventory.mjs [folder]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectDir, rel } from './lib.mjs';

const root = projectDir();
const start = path.resolve(root, process.argv[2] || '.');
const SKIP = new Set(['.git', 'node_modules', '.margin', '.obsidian', '.vscode', '.trash']);
const KINDS = {
  draft: ['.md', '.markdown', '.txt', '.docx', '.doc', '.tex', '.rtf', '.odt', '.fountain'],
  source: ['.pdf', '.epub', '.bib', '.ris', '.csl', '.html', '.htm'],
  data: ['.csv', '.xlsx', '.xls', '.json', '.tsv'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.heic']
};
const MAX_LIST = 300;
const MAX_HASH_BYTES = 20 * 1024 * 1024;

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  for (const [kind, exts] of Object.entries(KINDS)) if (exts.includes(ext)) return kind;
  return 'other';
}

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) {
      const stat = fs.statSync(full);
      files.push({ path: rel(root, full), kind: kindOf(full), bytes: stat.size, modified: stat.mtime.toISOString().slice(0, 10), full });
    }
  }
})(start);

const byHash = new Map();
for (const f of files) {
  if (f.bytes === 0 || f.bytes > MAX_HASH_BYTES) continue;
  const hash = crypto.createHash('sha1').update(fs.readFileSync(f.full)).digest('hex');
  if (!byHash.has(hash)) byHash.set(hash, []);
  byHash.get(hash).push(f.path);
}

const counts = {};
for (const f of files) counts[f.kind] = (counts[f.kind] || 0) + 1;
const folders = [...new Set(files.map((f) => path.posix.dirname(f.path)))].sort();

console.log(`Project: ${rel(root, start)}  (${files.length} files)`);
console.log(`By kind: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
console.log(`Folders: ${folders.join(', ') || '.'}`);
const dupes = [...byHash.values()].filter((group) => group.length > 1);
if (dupes.length) {
  console.log('Identical files:');
  for (const group of dupes) console.log(`  - ${group.join('  =  ')}`);
}
const empty = files.filter((f) => f.bytes === 0);
if (empty.length) console.log(`Empty files: ${empty.map((f) => f.path).join(', ')}`);
console.log('');
console.log('kind\tmodified\tKB\tpath');
for (const f of files.slice(0, MAX_LIST)) {
  console.log(`${f.kind}\t${f.modified}\t${Math.ceil(f.bytes / 1024)}\t${f.path}`);
}
if (files.length > MAX_LIST) console.log(`... and ${files.length - MAX_LIST} more. Run again on a subfolder to see them.`);
