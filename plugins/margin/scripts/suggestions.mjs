// The margin notes queue in .margin/suggestions.json. Claude adds notes here
// instead of editing the draft; the VS Code companion shows them at a pause.
// Usage:
//   node suggestions.mjs add --file <path> --line <n> --kind <kind> --message <text> [--source <where>]
//                                          repeat the flags for more notes; each note starts with --file
//   node suggestions.mjs add '<json>'      one note, or a JSON list of notes (older form)
//   node suggestions.mjs list [--all]
//   node suggestions.mjs dismiss <id>
//   node suggestions.mjs clear             removes dismissed notes
import path from 'node:path';
import crypto from 'node:crypto';
import { projectDir, scriptArgs, marginDir, readJson, writeJsonAtomic, keepAside, isPlainObject, rel } from './lib.mjs';

const root = projectDir();
const file = path.join(marginDir(root), 'suggestions.json');
const [command = 'list', ...rest] = scriptArgs();
const arg = rest[0];
const KINDS = ['citation', 'related', 'contradiction', 'todo', 'note'];

// Notes given as flags need no JSON quoting, which Windows PowerShell 5.1 breaks
// when it passes arguments to programs.
function notesFromFlags(args) {
  const notes = [];
  const problems = [];
  let current = null;
  for (let k = 0; k < args.length; k++) {
    const m = /^--(file|line|kind|message|source)(?:=([\s\S]*))?$/.exec(args[k]);
    if (!m) { problems.push(`Unknown option "${args[k]}" (use --file, --line, --kind, --message, --source)`); continue; }
    const value = m[2] !== undefined ? m[2] : args[++k];
    if (value === undefined) { problems.push(`--${m[1]} needs a value`); continue; }
    if (m[1] === 'file' || !current) { current = {}; notes.push(current); }
    current[m[1]] = value;
  }
  return { notes, problems };
}

// A damaged notes file is never silently replaced: adding a note keeps it aside
// first, and the other commands just say so.
function load() {
  const r = readJson(file);
  if (r.state === 'missing') return { data: { version: 1, items: [] } };
  if (r.state === 'ok' && isPlainObject(r.value) && Array.isArray(r.value.items) && r.value.items.every(isPlainObject)) {
    return { data: r.value };
  }
  return { damaged: r.problem || 'not a list of notes' };
}
const loaded = load();
let data = loaded.data;
const damaged = () => `Margin's notes file (.margin/suggestions.json) is damaged (${loaded.damaged}).`;

if (command === 'add') {
  let incoming;
  if (typeof arg === 'string' && arg.startsWith('--')) {
    const { notes, problems } = notesFromFlags(rest);
    if (problems.length) { for (const p of problems) console.log(`${p}.`); console.log('Nothing was queued.'); process.exit(1); }
    incoming = notes;
  } else {
    try { incoming = JSON.parse(arg); } catch {
      console.log('Pass the note as flags (add --file <path> --line <n> --kind <kind> --message <text>) or as JSON.');
      process.exit(1);
    }
  }
  if (loaded.damaged) {
    const kept = keepAside(file);
    console.log(`${damaged()} It was kept as ${rel(root, kept)}, and a new list was started.`);
    data = { version: 1, items: [] };
  }
  const list = Array.isArray(incoming) ? incoming : [incoming];
  for (const n of list) {
    if (!isPlainObject(n) || !n.file || !n.message) { console.log('Each note needs "file" and "message".'); continue; }
    data.items.push({
      id: crypto.randomBytes(3).toString('hex'),
      file: rel(root, String(n.file)),
      line: Number(n.line) || 1,
      kind: KINDS.includes(n.kind) ? n.kind : 'note',
      message: String(n.message).slice(0, 400),
      source: n.source ? String(n.source) : undefined,
      createdAt: new Date().toISOString(),
      status: 'open'
    });
  }
  writeJsonAtomic(file, data);
  console.log(`${list.length} note(s) queued. ${data.items.filter((i) => i.status === 'open').length} open in total.`);
} else if (command === 'list') {
  if (loaded.damaged) {
    console.log(`${damaged()} Its notes can't be listed. The next note added keeps the damaged file aside and starts a new list.`);
    process.exit(0);
  }
  const items = arg === '--all' ? data.items : data.items.filter((i) => i.status === 'open');
  if (!items.length) console.log('No open margin notes.');
  for (const i of items) console.log(`${i.id}  [${i.kind}]  ${i.file}:${i.line}  ${i.message}${i.status !== 'open' ? `  (${i.status})` : ''}`);
} else if (command === 'dismiss') {
  if (loaded.damaged) { console.log(`${damaged()} Notes can't be dismissed until a new list is started.`); process.exit(1); }
  const item = data.items.find((i) => i.id === arg);
  if (!item) { console.log(`No note with id ${arg}.`); process.exit(1); }
  item.status = 'dismissed';
  writeJsonAtomic(file, data);
  console.log(`Dismissed ${arg}.`);
} else if (command === 'clear') {
  if (loaded.damaged) { console.log(`${damaged()} Nothing was cleared.`); process.exit(1); }
  const before = data.items.length;
  data.items = data.items.filter((i) => i.status === 'open');
  writeJsonAtomic(file, data);
  console.log(`Removed ${before - data.items.length} dismissed note(s).`);
} else {
  console.log('Use add, list, dismiss or clear.');
  process.exit(1);
}
