// Check a draft's citation keys against a BibTeX file (for example a Zotero
// Better BibTeX export). Never invents a source: it only reports what is in
// the library and what isn't.
// Usage: node cite-check.mjs <draft> [library.bib]
//
// The library is the one named here, else the `bibliography` setting, else the
// newest .bib in the project (the others are listed in libraryCandidates).
// error: "no_library" | "library_missing" | "library_empty" means no key was
// checked. Each unresolved occurrence says its form: "latex" (\cite...),
// "bracketed" ([@key]) or "bare" (an @name in running text, which may be a
// mention rather than a citation).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDir, scriptArgs, loadSettings, rel, stripBom } from './lib.mjs';

// --------------------------------------------------------------------------
// BibTeX: a small scanner that follows braces, so an entry's end is its
// matching brace wherever it sits, and @comment/@preamble/@string are skipped.
// --------------------------------------------------------------------------

const SKIP_TYPES = new Set(['comment', 'preamble', 'string']);
const NEXT_ENTRY = /\n[ \t]*@[A-Za-z][\w-]*[ \t]*[{(]/y;

// The index of the character that ends an entry body starting at `i`. An entry
// that is never closed ends where the next entry starts.
function entryEnd(src, i, close) {
  let depth = 0;
  let inQuote = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { if (depth === 0 && close === '}') return i; depth = Math.max(0, depth - 1); }
    else if (c === '"' && depth === 0) inQuote = !inQuote;
    else if (c === ')' && close === ')' && depth === 0 && !inQuote) return i;
    else if (c === '\n' && depth === 0 && !inQuote) { NEXT_ENTRY.lastIndex = i; if (NEXT_ENTRY.test(src)) return i; }
  }
  return src.length;
}

function closeBrace(s, i) {
  let depth = 0;
  for (; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return s.length;
}

function closeQuote(s, i) {
  let depth = 0;
  for (i += 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth = Math.max(0, depth - 1);
    else if (s[i] === '"' && depth === 0) return i;
  }
  return s.length;
}

const ACCENTS = { '"': '̈', "'": '́', '`': '̀', '^': '̂', '~': '̃', '=': '̄', '.': '̇', u: '̆', v: '̌', H: '̋', c: '̧', k: '̨', r: '̊' };
const LETTERS = { ss: 'ß', aa: 'å', AA: 'Å', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', i: 'ı' };

// LaTeX field text to plain text, for showing a title or an author.
export function plain(value) {
  return value
    .replace(/\\([`'^"~=.]|[uvHckr](?![A-Za-z]))\s*\{?\s*(\\?[A-Za-z])\s*\}?/g, (all, accent, letter) => (letter.replace('\\', '') + ACCENTS[accent]).normalize('NFC'))
    .replace(/\\(ss|aa|AA|ae|AE|oe|OE|o|O|l|L|i)(?![A-Za-z])\s*/g, (all, name) => LETTERS[name])
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(/\\[A-Za-z]+\*?\s*/g, '')
    .replace(/---?/g, (d) => (d.length === 3 ? '—' : '–'))
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFields(s) {
  const fields = {};
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    const name = /^[A-Za-z][\w.:+-]*/.exec(s.slice(i, i + 80));
    if (!name) break;
    i += name[0].length;
    while (/\s/.test(s[i] || '')) i++;
    if (s[i] !== '=') break;
    i++;
    let value = '';
    for (;;) {
      while (/\s/.test(s[i] || '')) i++;
      if (s[i] === '{') { const e = closeBrace(s, i); value += s.slice(i + 1, e); i = e + 1; }
      else if (s[i] === '"') { const e = closeQuote(s, i); value += s.slice(i + 1, e); i = e + 1; }
      else { const bare = /^[^\s,#}]+/.exec(s.slice(i, i + 200)); if (!bare) break; value += bare[0]; i += bare[0].length; }
      while (/\s/.test(s[i] || '')) i++;
      if (s[i] === '#') { i++; continue; }
      break;
    }
    const key = name[0].toLowerCase();
    if (!(key in fields)) fields[key] = plain(value);
  }
  return fields;
}

// key -> { type, title, author, year }
export function parseBib(text) {
  const src = stripBom(text).replace(/\r\n?/g, '\n');
  const entries = new Map();
  const at = /@[ \t]*([A-Za-z][\w-]*)[ \t]*([{(])/g;
  let m;
  while ((m = at.exec(src))) {
    const type = m[1].toLowerCase();
    const start = at.lastIndex;
    const end = entryEnd(src, start, m[2] === '{' ? '}' : ')');
    at.lastIndex = end;
    if (SKIP_TYPES.has(type)) continue;
    const body = src.slice(start, end);
    const comma = body.indexOf(',');
    if (comma < 0) continue;
    const key = body.slice(0, comma).trim();
    if (!key || /[\s{}()",=#%'~\\]/.test(key) || entries.has(key)) continue;
    const f = parseFields(body.slice(comma + 1));
    entries.set(key, { type, title: f.title || f.booktitle || '', author: f.author || f.editor || '', year: f.year || (f.date || '').slice(0, 4) });
  }
  return entries;
}

// --------------------------------------------------------------------------
// Citations in the draft.
// --------------------------------------------------------------------------

// Replace a region with spaces, keeping line breaks so line numbers stay right.
const blankOut = (text) => text.replace(/[^\n]/g, ' ');

function blankRegions(text, kind) {
  let s = text;
  if (kind === 'tex') {
    s = s.replace(/\\begin\{(verbatim|lstlisting|minted|comment)\}[\s\S]*?\\end\{\1\}/g, blankOut);
    s = s.replace(/\\verb\*?([^A-Za-z\s])[\s\S]*?\1/g, blankOut);
    s = s.replace(/(^|[^\\])(%[^\n]*)/g, (all, before, comment) => before + blankOut(comment));
    return s;
  }
  // Markdown: YAML front matter, fenced and inline code, HTML comments.
  s = s.replace(/^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?=\n|$)/, blankOut);
  s = s.replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\2[`~]*[ \t]*(?=\n|$)|$)/gm, blankOut);
  s = s.replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, blankOut);
  s = s.replace(/<!--[\s\S]*?-->/g, blankOut);
  return s;
}

const NOT_CITATIONS = new Set(['citestyle']);

// [{ key, line, form: 'latex' | 'bracketed' | 'bare' }]
export function findCitations(text, kind = 'markdown') {
  const src = blankRegions(stripBom(text).replace(/\r\n?/g, '\n'), kind);
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const found = [];

  // LaTeX: \cite, \citep, \citeauthor, \parencite, \Textcite, \nocite, \cites{a}{b}, ...,
  // optional [..] and (..) arguments, keys over several lines.
  for (const m of src.matchAll(/\\([A-Za-z]*cite[A-Za-z]*)\*?/g)) {
    if (NOT_CITATIONS.has(m[1])) continue;
    const multi = /cites$/.test(m[1]);
    let i = m.index + m[0].length;
    for (;;) {
      while (/\s/.test(src[i] || '')) i++;
      if (src[i] === '[') { const e = src.indexOf(']', i); if (e < 0) break; i = e + 1; continue; }
      if (src[i] === '(' && multi) { const e = src.indexOf(')', i); if (e < 0) break; i = e + 1; continue; }
      if (src[i] !== '{') break;
      const e = src.indexOf('}', i);
      if (e < 0) break;
      let offset = i + 1;
      for (const raw of src.slice(i + 1, e).split(',')) {
        const key = raw.trim();
        if (key && key !== '*' && !/\s/.test(key)) found.push({ key, line: lineOf(offset + raw.indexOf(key)), form: 'latex' });
        offset += raw.length + 1;
      }
      i = e + 1;
      if (!multi) break;
    }
  }

  // Pandoc/Markdown: [@key], [see @a, p. 3; -@b], @key in running text, @{odd key}.
  if (kind !== 'tex') {
    const brackets = [];
    for (const m of src.matchAll(/\[[^\[\]]*?@[^\[\]]*?\]/g)) brackets.push([m.index, m.index + m[0].length]);
    const inBrackets = (i) => brackets.some(([a, b]) => i > a && i < b);
    const re = /(?<=^|[\s\[;(-])@(?:\{([^}\s][^}]*)\}|([\p{L}\p{N}_](?:[\p{L}\p{N}_:.#$%&\-+?<>~/]*[\p{L}\p{N}_])?))/gu;
    for (const m of src.matchAll(re)) {
      found.push({ key: m[1] || m[2], line: lineOf(m.index), form: inBrackets(m.index) ? 'bracketed' : 'bare' });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// --------------------------------------------------------------------------
// The command.
// --------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', '.margin', 'node_modules', '.trash', '.obsidian']);

// Every .bib in the project, newest first.
function findLibraries(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.bib')) {
        try { found.push({ full, mtime: fs.statSync(full).mtimeMs }); } catch { /* gone */ }
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime || a.full.localeCompare(b.full));
}

function main() {
  const root = projectDir();
  const [draftArg, bibArg] = scriptArgs();
  if (!draftArg) { console.log('Usage: node cite-check.mjs <draft> [library.bib]'); process.exit(1); }
  const draftPath = path.resolve(root, draftArg);
  const kind = /\.(tex|ltx|latex)$/i.test(draftPath) ? 'tex' : 'markdown';
  const citations = findCitations(fs.readFileSync(draftPath, 'utf8'), kind);

  const report = { draft: rel(root, draftPath), library: null, libraryChosenBy: null };
  let bibPath = null;
  const setting = loadSettings(root).bibliography;
  if (bibArg) { bibPath = path.resolve(root, bibArg); report.libraryChosenBy = 'argument'; }
  else if (setting) { bibPath = path.resolve(root, setting); report.libraryChosenBy = 'setting'; }
  else {
    const candidates = findLibraries(root);
    if (candidates.length) { bibPath = candidates[0].full; report.libraryChosenBy = 'newest'; }
    if (candidates.length > 1) report.libraryCandidates = candidates.map((c) => rel(root, c.full));
  }
  if (bibPath) report.library = rel(root, bibPath);

  let library = new Map();
  if (!bibPath) report.error = 'no_library';
  else if (!fs.existsSync(bibPath)) report.error = 'library_missing';
  else {
    library = parseBib(fs.readFileSync(bibPath, 'utf8'));
    if (!library.size) report.error = 'library_empty';
  }
  report.libraryEntries = library.size;
  report.citations = citations.length;
  report.distinctKeys = new Set(citations.map((c) => c.key)).size;

  const unresolved = [];
  let resolved = 0;
  if (!report.error) {
    const keys = [...library.keys()];
    for (const c of citations) {
      if (library.has(c.key)) { resolved++; continue; }
      const close = keys
        .map((k) => ({ k, d: distance(c.key.toLowerCase(), k.toLowerCase()) }))
        .filter((x) => x.d <= 3 || x.k.toLowerCase().startsWith(c.key.toLowerCase()))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map((x) => x.k);
      unresolved.push({
        ...c,
        closeMatches: close,
        closeMatchDetails: close.map((k) => { const e = library.get(k); return { key: k, author: e.author, year: e.year, title: e.title }; })
      });
    }
  }
  report.resolved = resolved;
  report.unresolved = unresolved;
  console.log(JSON.stringify(report, null, 2));
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
if (process.platform === 'win32' ? invokedAs.toLowerCase() === self.toLowerCase() : invokedAs === self) main();
