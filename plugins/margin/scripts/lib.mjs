// Shared helpers for Margin's hook and command scripts. No dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Reading and writing Margin's own files.
//
// Margin's files must never be half-written, and a damaged one must never be
// silently replaced: readers say whether a file is missing or damaged, writers
// write a temp file and rename it into place.
// ---------------------------------------------------------------------------

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readStdinJson() {
  try {
    const raw = stripBom(fs.readFileSync(0, 'utf8'));
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// { state: 'ok', value } | { state: 'missing' } | { state: 'damaged', problem }
export function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'missing' };
    return { state: 'damaged', problem: `can't be read (${err.code || err.message})` };
  }
  try {
    return { state: 'ok', value: JSON.parse(stripBom(raw)) };
  } catch {
    return { state: 'damaged', problem: raw.trim() ? 'not valid JSON' : 'empty' };
  }
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Rename, retrying once: on Windows a reader (an editor, a virus scanner) can
// briefly hold the destination open.
function renameWithRetry(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
    sleepSync(60);
    fs.renameSync(from, to);
  }
}

export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    renameWithRetry(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}
export const writeJson = writeJsonAtomic;

// One JSON object per line. Damaged lines are kept (as raw text) so a rewrite
// never loses them and line positions stay stable.
// Returns { entries, bad, lines }: entries are the parsed objects, bad the
// 1-based positions of damaged lines, lines every non-empty line in order as
// { n, value } or { n, raw }.
export function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { entries: [], bad: [], lines: [] };
    throw err;
  }
  const lines = [];
  for (const text of stripBom(raw).split('\n')) {
    if (!text.trim()) continue;
    const n = lines.length + 1;
    try {
      const value = JSON.parse(text);
      lines.push(isPlainObject(value) ? { n, value } : { n, raw: text.replace(/\r$/, '') });
    } catch {
      lines.push({ n, raw: text.replace(/\r$/, '') });
    }
  }
  return {
    entries: lines.filter((l) => l.value).map((l) => l.value),
    bad: lines.filter((l) => !l.value).map((l) => l.n),
    lines
  };
}

export function writeJsonlAtomic(file, lines) {
  const text = lines.map((l) => (l.value ? JSON.stringify(l.value) : l.raw)).join('\n');
  writeFileAtomic(file, text ? text + '\n' : '');
}

export function damagedLinesNote(bad, name) {
  if (!bad.length) return '';
  return `Note: ${bad.length} damaged line${bad.length === 1 ? '' : 's'} in .margin/${name} ${bad.length === 1 ? 'was' : 'were'} skipped (line ${bad.join(', ')}).`;
}

// Append one JSON line, first ending a cut-off last line so the new entry
// isn't glued onto it.
export function appendLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let prefix = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = '\n';
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // No file yet.
  }
  fs.appendFileSync(file, prefix + JSON.stringify(value) + '\n');
}

// A filesystem-safe timestamp, e.g. 2026-11-10T16-11-16-421Z.
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

// Move a damaged file out of the way, keeping it. Returns the new name.
export function keepAside(file) {
  const dest = `${file}.damaged-${stamp()}`;
  renameWithRetry(file, dest);
  return dest;
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Project and settings.
// ---------------------------------------------------------------------------

// Skills pass the project folder as `--project "${CLAUDE_PROJECT_DIR}"`, because
// commands Claude runs through its shell don't get CLAUDE_PROJECT_DIR, and the
// shell's folder can be a subfolder after a `cd`. scriptArgs() returns the
// script's own arguments without that flag.
let projectFlag;
export function scriptArgs(argv = process.argv.slice(2)) {
  const out = [];
  projectFlag = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project') projectFlag = argv[++i] ?? null;
    else if (argv[i].startsWith('--project=')) projectFlag = argv[i].slice('--project='.length);
    else out.push(argv[i]);
  }
  return out;
}

// A folder value nobody filled in ("", "${CLAUDE_PROJECT_DIR}", "$CLAUDE_PROJECT_DIR",
// "%CLAUDE_PROJECT_DIR%", "$env:CLAUDE_PROJECT_DIR") counts as absent.
function usableDir(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || /\$\{[^}]*\}|^\$\w|\$env:|^%[^%]+%$/i.test(v)) return null;
  return path.resolve(v);
}

const samePath = (a, b) => (IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b);

// The nearest folder at or above `start` passing `test`. It never climbs to the
// home folder (or above it) from below, so a stray .margin there can't capture
// every project.
function findUp(start, test) {
  const home = path.resolve(os.homedir());
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (dir !== start && samePath(dir, home)) return null;
    if (test(dir)) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

export const hasMarginMarker = (dir) =>
  fs.existsSync(path.join(dir, '.margin', 'settings.json')) || fs.existsSync(path.join(dir, '.margin', 'focus.json'));

// The project folder, in this order:
// 1. CLAUDE_PROJECT_DIR (hooks get it), else --project (skills pass it), else the
//    hook's cwd or the current folder; from there,
// 2. the nearest folder at or above it that already has Margin set up
//    (.margin/settings.json or .margin/focus.json), so a second .margin is never
//    made below one that exists;
// 3. otherwise the folder from step 1 if it was given explicitly, else the nearest
//    folder with .git, else the current folder.
export function projectDir(input = {}) {
  if (projectFlag === undefined) scriptArgs();
  const explicit = usableDir(process.env.CLAUDE_PROJECT_DIR) || usableDir(projectFlag);
  const start = explicit || usableDir(input.cwd) || path.resolve(process.cwd());
  const marked = findUp(start, hasMarginMarker);
  if (marked) return marked;
  if (explicit) return explicit;
  return findUp(start, (dir) => fs.existsSync(path.join(dir, '.git'))) || start;
}

export function marginDir(root) {
  return path.join(root, '.margin');
}

// Margin is "set up" in a project once .margin/settings.json exists (written by
// /margin:setup, or by `settings.mjs ensure` at the start of any Margin command
// that changes something). Until then the hooks do nothing, except that a focus
// list, once set, is always enforced.
export const settingsPath = (root) => path.join(marginDir(root), 'settings.json');
export const focusPath = (root) => path.join(marginDir(root), 'focus.json');
export const isSetUp = (root) => fs.existsSync(settingsPath(root));

export const DEFAULT_SETTINGS = {
  drafts: 'drafts',
  notes: 'notes',
  sources: 'sources',
  bibliography: '',
  suggestBreaks: true,
  storyLength: 'short'
};

export const isSettingName = (key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key);

// { state: 'missing' | 'ok' | 'damaged', settings, problems, extra }
// settings always holds every known key with a value of the right type; a
// value of the wrong type is ignored (and named in problems). extra keeps keys
// Margin doesn't know, so a rewrite doesn't drop them.
export function readSettings(root) {
  const file = path.join(marginDir(root), 'settings.json');
  const r = readJson(file);
  const settings = { ...DEFAULT_SETTINGS };
  const problems = [];
  const extra = {};
  if (r.state === 'missing') return { state: 'missing', file, settings, problems, extra };
  if (r.state === 'damaged' || !isPlainObject(r.value)) {
    return { state: 'damaged', file, settings, problems: [r.problem || 'not a list of settings'], extra };
  }
  for (const [key, value] of Object.entries(r.value)) {
    if (!isSettingName(key)) extra[key] = value;
    else if (typeof value === typeof DEFAULT_SETTINGS[key]) settings[key] = value;
    else problems.push(`ignored ${key}: ${JSON.stringify(value)} (expected ${typeof DEFAULT_SETTINGS[key] === 'boolean' ? 'yes or no' : 'text'})`);
  }
  return { state: 'ok', file, settings, problems, extra };
}

export function loadSettings(root) {
  return readSettings(root).settings;
}

export function loadFocus(root) {
  const r = readJson(path.join(marginDir(root), 'focus.json'));
  const focus = r.state === 'ok' && isPlainObject(r.value) ? r.value : {};
  return { enabled: Boolean(focus.enabled), paths: Array.isArray(focus.paths) ? focus.paths : [] };
}

export function saveFocus(root, focus) {
  writeJsonAtomic(path.join(marginDir(root), 'focus.json'), focus);
}

// ---------------------------------------------------------------------------
// Paths.
// ---------------------------------------------------------------------------

function normalize(p) {
  const resolved = path.resolve(p);
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

// True when `target` is `base` itself or anything below it.
export function isInside(target, base) {
  const t = normalize(target);
  const b = normalize(base);
  if (t === b) return true;
  return t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// Project-relative path with forward slashes, for display and storage.
export function rel(root, target) {
  return path.relative(root, path.resolve(root, target)).split(path.sep).join('/') || '.';
}
