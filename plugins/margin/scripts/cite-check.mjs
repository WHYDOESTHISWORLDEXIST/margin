// Check a draft's citation keys against a BibTeX file (for example a Zotero
// Better BibTeX export). Never invents a source: it only reports what is in
// the library and what isn't.
// Usage: node cite-check.mjs <draft> [library.bib]
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, loadSettings, rel } from './lib.mjs';

const root = projectDir();
const [draftArg, bibArg] = process.argv.slice(2);
if (!draftArg) { console.log('Usage: node cite-check.mjs <draft> [library.bib]'); process.exit(1); }

function findBib() {
  if (bibArg) return path.resolve(root, bibArg);
  const settings = loadSettings(root);
  if (settings.bibliography) return path.resolve(root, settings.bibliography);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.margin'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name.toLowerCase().endsWith('.bib')) return full;
    }
  }
  return null;
}

function parseBib(text) {
  const entries = new Map();
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(text))) {
    const field = (name) => {
      const f = new RegExp(`\\b${name}\\s*=\\s*[{"]([\\s\\S]*?)[}"]\\s*,?\\s*\\n`, 'i').exec(m[3] + '\n');
      return f ? f[1].replace(/[{}]/g, '').replace(/\s+/g, ' ').trim() : '';
    };
    entries.set(m[2], { type: m[1].toLowerCase(), title: field('title'), author: field('author'), year: field('year') || field('date').slice(0, 4) });
  }
  return entries;
}

function findCitations(text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\\(?:auto|paren|text|foot)?cite[pt]?\*?(?:\[[^\]]*\])*\{([^}]+)\}/g)) {
      for (const key of m[1].split(',')) found.push({ key: key.trim(), line: i + 1 });
    }
    for (const m of line.matchAll(/(?:^|[\s\[;(])-?@([A-Za-z0-9_][\w:.#$%&\-+?<>~/]*[A-Za-z0-9_])/g)) {
      found.push({ key: m[1], line: i + 1 });
    }
  });
  return found;
}

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const draftPath = path.resolve(root, draftArg);
const draft = fs.readFileSync(draftPath, 'utf8');
const bibPath = findBib();
const library = bibPath && fs.existsSync(bibPath) ? parseBib(fs.readFileSync(bibPath, 'utf8')) : new Map();
const keys = [...library.keys()];

const citations = findCitations(draft);
const resolved = [];
const unresolved = [];
for (const c of citations) {
  if (library.has(c.key)) resolved.push({ ...c, ...library.get(c.key) });
  else {
    const close = keys
      .map((k) => ({ k, d: distance(c.key.toLowerCase(), k.toLowerCase()) }))
      .filter((x) => x.d <= 3 || x.k.toLowerCase().startsWith(c.key.toLowerCase()))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map((x) => x.k);
    unresolved.push({ ...c, closeMatches: close });
  }
}

console.log(JSON.stringify({
  draft: rel(root, draftPath),
  library: bibPath ? rel(root, bibPath) : null,
  libraryEntries: library.size,
  citations: citations.length,
  resolved: resolved.length,
  unresolved
}, null, 2));
