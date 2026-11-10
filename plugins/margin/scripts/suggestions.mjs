// The margin notes queue in .margin/suggestions.json. Claude adds notes here
// instead of editing the draft; the VS Code companion shows them at a pause.
// Usage:
//   node suggestions.mjs add '<json>'      one note, or a JSON list of notes
//   node suggestions.mjs list [--all]
//   node suggestions.mjs dismiss <id>
//   node suggestions.mjs clear             removes dismissed notes
import path from 'node:path';
import crypto from 'node:crypto';
import { projectDir, scriptArgs, marginDir, readJson, writeJsonAtomic, keepAside, isPlainObject, rel } from './lib.mjs';

const root = projectDir();
const file = path.join(marginDir(root), 'suggestions.json');
const [command = 'list', arg] = scriptArgs();
const KINDS = ['citation', 'related', 'contradiction', 'todo', 'note'];

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
  try { incoming = JSON.parse(arg); } catch { console.log('Pass the note as JSON.'); process.exit(1); }
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
