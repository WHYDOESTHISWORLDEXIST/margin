// Manage which files Claude may read.
// Usage: node focus.mjs status | add <path...> | remove <path...> | on | off | clear
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, loadFocus, saveFocus, rel } from './lib.mjs';

const root = projectDir();
const [command = 'status', ...items] = process.argv.slice(2);
const focus = loadFocus(root);
const say = (line) => console.log(line);

function show() {
  say(`Focus is ${focus.enabled ? 'ON' : 'OFF'}.`);
  if (focus.paths.length) {
    say('Claude may read:');
    for (const p of focus.paths) say(`  - ${p}`);
  } else {
    say('No files or folders picked yet.');
  }
  if (!focus.enabled && focus.paths.length) say('(The list is saved but not enforced while focus is off.)');
}

switch (command) {
  case 'status':
    show();
    break;
  case 'add': {
    if (!items.length) { say('Name at least one file or folder to add.'); process.exit(1); }
    const missing = [];
    for (const item of items) {
      const target = path.resolve(root, item);
      if (!fs.existsSync(target)) { missing.push(item); continue; }
      const r = rel(root, target);
      if (!focus.paths.includes(r)) focus.paths.push(r);
    }
    const wasOff = !focus.enabled;
    focus.enabled = true;
    saveFocus(root, focus);
    if (missing.length) say(`Not found, skipped: ${missing.join(', ')}`);
    if (wasOff) say('Focus turned ON.');
    show();
    break;
  }
  case 'remove': {
    const drop = new Set(items.map((i) => rel(root, i)));
    focus.paths = focus.paths.filter((p) => !drop.has(p));
    saveFocus(root, focus);
    show();
    break;
  }
  case 'on':
    focus.enabled = true;
    saveFocus(root, focus);
    show();
    if (!focus.paths.length) say('Nothing is picked yet, so Claude can read no project files until you add some.');
    break;
  case 'off':
    focus.enabled = false;
    saveFocus(root, focus);
    show();
    break;
  case 'clear':
    focus.enabled = false;
    focus.paths = [];
    saveFocus(root, focus);
    say('Focus cleared and turned OFF.');
    break;
  default:
    say(`Unknown command "${command}". Use status, add, remove, on, off or clear.`);
    process.exit(1);
}
