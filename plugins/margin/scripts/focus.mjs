// Manage which files Claude may read.
// Usage: node focus.mjs status | add <path...> | remove <path...> | on | off | clear
// A damaged focus list is repaired first (a copy is kept), whatever the command.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir, scriptArgs, readFocus, repairFocus, saveFocus, rel, onDiskSpelling, sameFile } from './lib.mjs';

const root = projectDir();
const [command = 'status', ...items] = scriptArgs();
const say = (line) => console.log(line);

const current = readFocus(root);
const focus = { enabled: current.enabled, paths: current.paths };
if (current.state === 'damaged' || current.warning) {
  const repaired = repairFocus(root);
  focus.enabled = repaired.enabled;
  focus.paths = repaired.paths;
  say(`Margin's focus list was damaged (${current.problem || current.warning}). A copy was kept as ${rel(root, repaired.kept)}, and the list was repaired with what could still be read. Check it below.`);
}

// A path with spaces typed without quotes arrives as several words. When a word
// isn't a path on its own but it and the words after it are, put them back
// together (and say so), rather than acting on the wrong file.
function rejoin(words, isPath) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (isPath(words[i])) { out.push(words[i]); continue; }
    let j = i + 1;
    while (j < words.length && !isPath(words.slice(i, j + 1).join(' '))) j++;
    if (j < words.length) {
      const joined = words.slice(i, j + 1).join(' ');
      say(`Read "${words.slice(i, j + 1).join('" "')}" as one path: "${joined}".`);
      out.push(joined);
      i = j;
    } else {
      out.push(words[i]);
    }
  }
  return out;
}

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
    const exists = (p) => fs.existsSync(path.resolve(root, p));
    const missing = [];
    let found = 0;
    for (const item of rejoin(items, exists)) {
      if (!exists(item)) { missing.push(item); continue; }
      found++;
      const r = onDiskSpelling(root, rel(root, item));
      if (!focus.paths.includes(r)) focus.paths.push(r);
    }
    if (!found) {
      // Only typos: change nothing, rather than switching focus on with nothing to read.
      say(`Not found: ${missing.join(', ')}. Nothing was added, so focus stays ${focus.enabled ? 'ON' : 'OFF'}.`);
      show();
      process.exit(1);
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
    // Names are compared the way the drive compares them ("Drafts" is "drafts" where
    // case doesn't matter), and a name that matches nothing is said so.
    const listed = (p) => focus.paths.some((q) => sameFile(root, q, rel(root, p)));
    const names = rejoin(items, listed);
    const missing = names.filter((name) => !listed(name));
    const before = focus.paths.length;
    focus.paths = focus.paths.filter((q) => !names.some((name) => sameFile(root, q, rel(root, name))));
    if (missing.length) say(`Not in the list: ${missing.join(', ')}.`);
    if (focus.paths.length !== before) saveFocus(root, focus);
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
