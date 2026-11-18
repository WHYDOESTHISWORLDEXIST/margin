// UserPromptSubmit hook: when focus is on, tell Claude which files it may use,
// so it doesn't waste a turn trying files the guard will block. If the focus
// list is damaged, say so, so Claude can tell the writer how to repair it.
import fs from 'node:fs';
import { readStdinJson, projectDir, focusPath, readFocus } from './lib.mjs';

const input = readStdinJson();
const root = projectDir(input);
if (!fs.existsSync(focusPath(root))) process.exit(0);
const focus = readFocus(root);

function tell(text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));
}

if (focus.state === 'damaged') {
  tell(
    `Margin's focus list (.margin/focus.json) is damaged (${focus.problem}), so reading project files is paused. ` +
    'Tell the writer, and suggest /margin:focus status, which repairs it.'
  );
} else if (focus.enabled) {
  const list = focus.paths.length ? focus.paths.join(', ') : 'nothing yet';
  tell(
    `Margin focus is on. The writer has limited reading to: ${list}. ` +
    'Files outside that list are blocked; if one seems needed, the writer can add it with /margin:focus add <path>.' +
    (focus.warning ? ` (${focus.warning}; /margin:focus status tidies the list.)` : '')
  );
}

process.exit(0);
