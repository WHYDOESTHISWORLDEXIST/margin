// The margin notes queue in .margin/suggestions.json. Claude adds notes here
// instead of editing the draft; the VS Code companion shows them at a pause.
// Usage:
//   node suggestions.mjs add '<json>'      one note, or a JSON list of notes
//   node suggestions.mjs list [--all]
//   node suggestions.mjs dismiss <id>
//   node suggestions.mjs clear             removes dismissed notes
import path from 'node:path';
import crypto from 'node:crypto';
import { projectDir, marginDir, readJson, writeJson, rel } from './lib.mjs';

const root = projectDir();
const file = path.join(marginDir(root), 'suggestions.json');
const data = readJson(file, { version: 1, items: [] });
const [command = 'list', arg] = process.argv.slice(2);
const KINDS = ['citation', 'related', 'contradiction', 'todo', 'note'];

if (command === 'add') {
  let incoming;
  try { incoming = JSON.parse(arg); } catch { console.log('Pass the note as JSON.'); process.exit(1); }
  const list = Array.isArray(incoming) ? incoming : [incoming];
  for (const n of list) {
    if (!n.file || !n.message) { console.log('Each note needs "file" and "message".'); continue; }
    data.items.push({
      id: crypto.randomBytes(3).toString('hex'),
      file: rel(root, n.file),
      line: Number(n.line) || 1,
      kind: KINDS.includes(n.kind) ? n.kind : 'note',
      message: String(n.message).slice(0, 400),
      source: n.source ? String(n.source) : undefined,
      createdAt: new Date().toISOString(),
      status: 'open'
    });
  }
  writeJson(file, data);
  console.log(`${list.length} note(s) queued. ${data.items.filter((i) => i.status === 'open').length} open in total.`);
} else if (command === 'list') {
  const items = arg === '--all' ? data.items : data.items.filter((i) => i.status === 'open');
  if (!items.length) console.log('No open margin notes.');
  for (const i of items) console.log(`${i.id}  [${i.kind}]  ${i.file}:${i.line}  ${i.message}${i.status !== 'open' ? `  (${i.status})` : ''}`);
} else if (command === 'dismiss') {
  const item = data.items.find((i) => i.id === arg);
  if (!item) { console.log(`No note with id ${arg}.`); process.exit(1); }
  item.status = 'dismissed';
  writeJson(file, data);
  console.log(`Dismissed ${arg}.`);
} else if (command === 'clear') {
  const before = data.items.length;
  data.items = data.items.filter((i) => i.status === 'open');
  writeJson(file, data);
  console.log(`Removed ${before - data.items.length} dismissed note(s).`);
} else {
  console.log('Use add, list, dismiss or clear.');
  process.exit(1);
}
