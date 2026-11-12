// Shared helpers for Margin's hook and command scripts. No dependencies.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// node:crypto is only needed after an edit, so hooks that run on every read or
// prompt don't pay for loading it.
const requireBuiltin = createRequire(import.meta.url);

export const IS_WINDOWS = process.platform === 'win32';

// Whether the module at `moduleUrl` is the script node was started with. Both
// sides are compared where they really point: Node follows links (symlinks,
// Windows junctions) for a module's own URL but keeps process.argv[1] as typed,
// so a plugin reached through a link would otherwise never run its main().
export function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const invoked = real(path.resolve(process.argv[1]));
  const self = real(fileURLToPath(moduleUrl));
  return IS_WINDOWS || process.platform === 'darwin' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
}

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
export function renameWithRetry(from, to) {
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

// Whether file names ignore case is a property of the drive, not the OS: macOS
// drives usually ignore it (but can be case-sensitive), Linux ones usually
// don't (but USB sticks do). Start from the OS's usual rule and, once the
// project folder is known, check: look for that folder under its name with the
// case flipped.
let caseInsensitive = IS_WINDOWS || process.platform === 'darwin';
export function learnCaseRule(dir) {
  const name = path.basename(dir);
  const flipped = name === name.toLowerCase() ? name.toUpperCase() : name.toLowerCase();
  if (flipped !== name && fs.existsSync(dir)) caseInsensitive = fs.existsSync(path.join(path.dirname(dir), flipped));
  return caseInsensitive;
}

const samePath = (a, b) => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);

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
  const root = findUp(start, hasMarginMarker) || explicit || findUp(start, (dir) => fs.existsSync(path.join(dir, '.git'))) || start;
  learnCaseRule(root);
  return root;
}

// A project-relative path spelled the way it is on disk ("Drafts/Ch3.md" for a
// typed "drafts/ch3.md" on a drive that ignores case), so lists Margin keeps
// match what Claude's tools report. Parts that don't exist are kept as typed.
export function onDiskSpelling(root, relPath) {
  let dir = root;
  const out = [];
  for (const part of relPath.split('/').filter(Boolean)) {
    let name = part;
    if (part !== '.' && part !== '..') {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { /* not a folder */ }
      if (!names.includes(part)) name = names.find((n) => n.toLowerCase() === part.toLowerCase()) || part;
    }
    out.push(name);
    dir = path.join(dir, name);
  }
  return out.join('/') || '.';
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

// Settings that take one of a few words.
export const SETTING_CHOICES = { storyLength: ['flash', 'short', 'long'] };
const YES = ['true', 'yes', 'on', '1'];
const NO = ['false', 'no', 'off', '0'];

// What a setting takes, in words: "yes or no", "flash, short or long", "text".
export function settingHint(key) {
  if (typeof DEFAULT_SETTINGS[key] === 'boolean') return 'yes or no';
  const choices = SETTING_CHOICES[key];
  return choices ? `${choices.slice(0, -1).join(', ')} or ${choices[choices.length - 1]}` : 'text';
}

// The value to save for a typed answer, or undefined when the setting doesn't take it.
export function parseSetting(key, raw) {
  const word = String(raw).trim().toLowerCase();
  if (typeof DEFAULT_SETTINGS[key] === 'boolean') return YES.includes(word) ? true : NO.includes(word) ? false : undefined;
  if (SETTING_CHOICES[key]) return SETTING_CHOICES[key].includes(word) ? word : undefined;
  return String(raw);
}

const settingOk = (key, value) => typeof value === typeof DEFAULT_SETTINGS[key] && (!SETTING_CHOICES[key] || SETTING_CHOICES[key].includes(value));

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
    else if (settingOk(key, value)) settings[key] = value;
    else problems.push(`ignored ${key}: ${JSON.stringify(value)} (expected ${settingHint(key)})`);
  }
  return { state: 'ok', file, settings, problems, extra };
}

export function loadSettings(root) {
  return readSettings(root).settings;
}

// The focus list. { state: 'missing' | 'ok' | 'damaged', enabled, paths, problem, warning }
// A file that exists but can't be understood is 'damaged': the guard then pauses
// Claude's reads rather than silently dropping the writer's focus. Entries that
// aren't file names are left out (that only narrows the list) and named in warning.
export function readFocus(root) {
  const r = readJson(focusPath(root));
  if (r.state === 'missing') return { state: 'missing', enabled: false, paths: [] };
  const v = r.value;
  if (r.state === 'damaged' || !isPlainObject(v) || typeof v.enabled !== 'boolean' || !Array.isArray(v.paths)) {
    return { state: 'damaged', enabled: false, paths: [], problem: r.problem || 'unexpected contents' };
  }
  const paths = v.paths.filter((p) => typeof p === 'string' && p.trim() !== '');
  const dropped = v.paths.length - paths.length;
  const warning = dropped ? `${dropped} focus entr${dropped === 1 ? 'y that isn\'t a file name was' : 'ies that aren\'t file names were'} ignored` : undefined;
  return { state: 'ok', enabled: v.enabled, paths, warning };
}

// Best-effort recovery of a damaged focus file: every complete file name that can
// still be read, and focus ON unless the file clearly said off.
export function salvageFocus(root) {
  let raw = '';
  try { raw = stripBom(fs.readFileSync(focusPath(root), 'utf8')); } catch { /* unreadable */ }
  let value;
  try { value = JSON.parse(raw); } catch { /* damaged */ }
  let enabled = true;
  const paths = [];
  if (isPlainObject(value)) {
    if (typeof value.enabled === 'boolean') enabled = value.enabled;
    else if (value.enabled === 'false') enabled = false;
    const list = Array.isArray(value.paths) ? value.paths : [value.paths];
    for (const p of list) if (typeof p === 'string' && p.trim()) paths.push(p);
  } else {
    const flag = /"enabled"\s*:\s*(true|false)/.exec(raw);
    if (flag) enabled = flag[1] === 'true';
    const start = raw.search(/"paths"\s*:\s*\[/);
    if (start >= 0) {
      const body = raw.slice(raw.indexOf('[', start) + 1);
      const list = body.includes(']') ? body.slice(0, body.indexOf(']')) : body;
      for (const m of list.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
        try { const p = JSON.parse(`"${m[1]}"`); if (p.trim()) paths.push(p); } catch { /* skip */ }
      }
    }
  }
  return { enabled, paths: [...new Set(paths)] };
}

// Keep a copy of the damaged file, then write the salvaged list in its place.
export function repairFocus(root) {
  const salvaged = salvageFocus(root);
  const kept = keepAside(focusPath(root));
  saveFocus(root, salvaged);
  return { kept, ...salvaged };
}

export function saveFocus(root, focus) {
  writeJsonAtomic(focusPath(root), { enabled: Boolean(focus.enabled), paths: focus.paths });
}

// What focus lets Claude read, shared by the Read/Grep guard and the shell
// guard so both decide alike and say the same thing. reasonFor(path) and
// searchReasonFor(folder) return null when allowed, else the reason to give.
// Locations are compared where they really point, so a link (symlink or Windows
// junction) inside a focus folder can't reach outside it.
export function focusRules(root, input, focus) {
  // Where things really point is looked up once per run: a long shell command can
  // name the same folders many times.
  const realCache = new Map();
  const real = (p) => { let r = realCache.get(p); if (r === undefined) { r = realPath(p); realCache.set(p, r); } return r; };
  const realRoot = () => real(root);
  let focusBases;
  const bases = () => (focusBases ??= focus.paths.map((p) => real(path.resolve(root, p))));
  let sessions;
  const list = focus.paths.length ? focus.paths.join(', ') : '(nothing picked yet)';
  const damaged = focus.state === 'damaged'
    ? `Margin's focus list (.margin/focus.json) is damaged (${focus.problem}), so reading files is paused to keep the writer's focus. Ask the writer to run /margin:focus status, which repairs it.`
    : null;

  // Claude Code's own working files for this session: its scratchpad, and the
  // folder next to the transcript where it saves long tool results for Claude to
  // read back. Only outside the project, so they can never open a hole in it.
  function sessionFolders() {
    if (sessions) return sessions;
    const out = [];
    if (typeof input.scratchpad_dir === 'string' && input.scratchpad_dir.trim()) out.push(real(input.scratchpad_dir));
    if (typeof input.transcript_path === 'string' && /\.jsonl$/i.test(input.transcript_path)) {
      const t = path.resolve(input.transcript_path);
      out.push(real(path.join(path.dirname(t), path.basename(t).replace(/\.jsonl$/i, ''))));
    }
    return (sessions = out.filter((dir) => !isInside(dir, realRoot()) && !isInside(realRoot(), dir)));
  }

  // Always readable: the plugin's own files, the session folders above, and
  // Margin's own files right inside .margin/ (settings, focus list, notes, logs).
  // Not .margin/history/ or .margin/trash/: they hold copies of the writer's
  // files, including ones outside the focus list.
  function alwaysAllowed(realTarget) {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (pluginRoot && isInside(realTarget, real(pluginRoot))) return true;
    if (sessionFolders().some((dir) => isInside(realTarget, dir))) return true;
    if (fileKey(root, path.dirname(realTarget)) !== fileKey(root, real(marginDir(root)))) return false;
    if (['history', 'trash'].includes(path.basename(realTarget).toLowerCase())) return false;
    try { return !fs.statSync(realTarget).isDirectory(); } catch { return true; }
  }

  function reasonFor(target) {
    const realTarget = real(target);
    if (alwaysAllowed(realTarget)) return null;
    if (damaged) return damaged;
    if (bases().some((b) => isInside(realTarget, b))) return null;
    if (!isInside(realTarget, realRoot())) {
      return `Margin focus is on, and ${target} is outside this project. Claude can read only: ${list}. Ask the writer before going further.`;
    }
    return (
      `Margin focus is on, and ${rel(root, target)} isn't in it. ` +
      `Claude can read only: ${list}. ` +
      `Ask the writer before going further. They can widen it with "/margin:focus add ${rel(root, target)}" or turn it off with "/margin:focus off".`
    );
  }

  // A search of `dir` and everything below it.
  function searchReasonFor(dir) {
    const realDir = real(dir);
    if (!damaged && !alwaysAllowed(realDir) && isInside(realRoot(), realDir) && !bases().some((b) => isInside(realDir, b))) {
      return `Margin focus is on, so searching the whole project is blocked. Search inside one of: ${list}.`;
    }
    return reasonFor(dir);
  }

  return { reasonFor, searchReasonFor, list };
}

// ---------------------------------------------------------------------------
// Paths.
// ---------------------------------------------------------------------------

function normalize(p) {
  const resolved = path.resolve(p);
  return caseInsensitive ? resolved.toLowerCase() : resolved;
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

// Where a path really points, following links (symlinks, Windows junctions,
// macOS's /var -> /private/var). For a path that doesn't exist yet, the nearest
// existing folder above it is resolved and the rest is kept as written.
export function realPath(p) {
  const tail = [];
  let base = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(base), ...tail);
    } catch {
      const parent = path.dirname(base);
      if (parent === base) return path.resolve(p);
      tail.unshift(path.basename(base));
      base = parent;
    }
  }
}

// A key that is equal for two paths naming the same file (case-insensitive where the OS is).
export function fileKey(root, p) {
  return normalize(path.resolve(root, p));
}

export function sameFile(root, a, b) {
  return fileKey(root, a) === fileKey(root, b);
}

// ---------------------------------------------------------------------------
// Changes, backups and the change log.
// ---------------------------------------------------------------------------

export const logPath = (root) => path.join(marginDir(root), 'log.jsonl');

const HASH_LIMIT = 20 * 1024 * 1024;

// What a file holds right now, cheaply comparable later: 'absent', a SHA-1 of the
// content, or (above 20 MB) its size and modification time.
export function fingerprint(file) {
  let st;
  try { st = fs.statSync(file); } catch { return 'absent'; }
  if (!st.isFile()) return 'absent';
  if (st.size > HASH_LIMIT) return `size:${st.size}:mtime:${Math.round(st.mtimeMs)}`;
  return 'sha1:' + requireBuiltin('node:crypto').createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

// Copy a file into place without ever leaving a half-written file behind.
export function copyFileAtomic(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.copyFileSync(src, tmp);
  try {
    renameWithRetry(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// A file name that is valid on every system: no characters Windows refuses, no
// trailing dots or spaces, and short enough that the whole name stays well under
// the 255-character limit (the extension is kept).
export function safeFileName(name, max = 80) {
  let s = String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (!s) s = 'file';
  if (s.length > max) {
    const ext = (path.extname(s).match(/^\.[A-Za-z0-9_-]{1,12}$/) || [''])[0];
    s = s.slice(0, max - ext.length) + ext;
  }
  return s;
}

// Where a new backup copy of a project file goes: <stamp>__<n>__<file name>. The
// name only has to be valid and unique: which file a backup belongs to, and where
// it lives, is recorded in the log and the pending records, so nothing ever works
// it out from the name (older backups named <stamp>__<folder>__<file> still work).
export function newSnapshot(root, relFile) {
  const dir = path.join(marginDir(root), 'history');
  const at = stamp();
  const name = safeFileName(String(relFile).split(/[\\/]/).pop());
  let abs;
  for (let n = 1; ; n++) {
    abs = path.join(dir, `${at}__${n}__${name}`);
    if (!fs.existsSync(abs)) break;
  }
  return { abs, rel: rel(root, abs) };
}

// Run fn while holding .margin/<name>.lock, so a hook appending to the change log
// and /margin:review rewriting it can't lose each other's lines. Waits up to 3 s,
// clears a lock left behind by a crash after 10 s, and never blocks for longer.
export function withLock(root, name, fn) {
  const lock = path.join(marginDir(root), `${name}.lock`);
  const deadline = Date.now() + 3000;
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmSync(lock, { force: true }); continue; }
      } catch { continue; }
      if (Date.now() > deadline) break;
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
  }
}

// Changes are numbered by a stable id. Older logs have no ids; their entries are
// numbered by their line, which is what /margin:review always showed.
export function readChanges(root) {
  const log = readJsonl(logPath(root));
  const changes = log.lines
    .filter((l) => l.value)
    .map((l) => ({ id: Number.isInteger(l.value.id) && l.value.id > 0 ? l.value.id : l.n, e: l.value }));
  return { log, changes };
}

// The id for the next change: one more than the last line's id (read from the
// end of the file, so it stays cheap as the log grows), or for an older log one
// more than the number of lines.
export function nextChangeId(root) {
  const file = logPath(root);
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return 1; }
  try {
    const size = fs.fstatSync(fd).size;
    if (!size) return 1;
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const last = buf.toString('utf8').split('\n').filter((l) => l.trim()).pop();
    try {
      const value = JSON.parse(last);
      if (Number.isInteger(value.id) && value.id > 0) return value.id + 1;
    } catch { /* fall through to a full read */ }
  } finally {
    fs.closeSync(fd);
  }
  const { lines } = readJsonl(file);
  let max = lines.length;
  for (const l of lines) if (l.value && Number.isInteger(l.value.id) && l.value.id > max) max = l.value.id;
  return max + 1;
}

// "2026-11-10 11:40" in the writer's own time zone.
export function localTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// The history is tidied after every this-many logged changes (see history.mjs).
// MARGIN_TEST_PRUNE_EVERY exists for the tests only.
export const TIDY_EVERY = Math.max(1, Number(process.env.MARGIN_TEST_PRUNE_EVERY) || 50);

// Tool-use ids name pending files; anything that could leave the folder is refused.
export const safeToolUseId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id);
