// UserPromptSubmit hook: when focus is on, tell Claude which files it may use,
// so it doesn't waste a turn trying files the guard will block.
import fs from 'node:fs';
import { readStdinJson, projectDir, focusPath, loadFocus } from './lib.mjs';

const input = readStdinJson();
const root = projectDir(input);
if (!fs.existsSync(focusPath(root))) process.exit(0);
const focus = loadFocus(root);

if (focus.enabled) {
  const list = focus.paths.length ? focus.paths.join(', ') : 'nothing yet';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        `Margin focus is on. The writer has limited reading to: ${list}. ` +
        'Files outside that list are blocked; if one seems needed, the writer can add it with /margin:focus add <path>.'
    }
  }));
}

process.exit(0);
