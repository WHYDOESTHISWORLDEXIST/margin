// PostToolUse hook: record every file Claude changed in .margin/log.jsonl,
// with the backup made by guard.mjs, so /margin:review can show it.
// Each entry gets a stable id and a fingerprint of the file just after the
// change, so undo can tell whether anything changed it since.
// PostToolUseFailure / PermissionDenied: the edit didn't happen, so its backup
// is dropped. Every 50th change, history.mjs tidies .margin/history/.
// Does nothing in a project where Margin isn't set up, and never creates .margin/.
import fs from 'node:fs';
import path from 'node:path';
import {
  readStdinJson, projectDir, marginDir, isSetUp, readJson, isPlainObject, appendLine, rel, isInside,
  logPath, withLock, nextChangeId, fingerprint, safeToolUseId, TIDY_EVERY
} from './lib.mjs';

const input = readStdinJson();
const root = projectDir(input);
if (!fs.existsSync(marginDir(root))) process.exit(0);

const event = input.hook_event_name;
if (event === 'PostToolUseFailure' || event === 'PermissionDenied') {
  const { discardPending } = await import('./history.mjs');
  discardPending(root, input.tool_use_id);
  process.exit(0);
}

const args = input.tool_input || {};
const file = args.file_path || args.notebook_path;
let id = null;

if (file && !isInside(path.resolve(root, file), marginDir(root))) {
  const pendingFile = safeToolUseId(input.tool_use_id) ? path.join(marginDir(root), 'history', 'pending', `${input.tool_use_id}.json`) : null;
  const read = pendingFile ? readJson(pendingFile) : { state: 'missing' };
  const pending = read.state === 'ok' && isPlainObject(read.value) ? read.value : null;
  // A change in a set-up project is listed even if its backup failed.
  if (pending || isSetUp(root)) {
    const after = fingerprint(path.resolve(root, file));
    withLock(root, 'log', () => {
      id = nextChangeId(root);
      appendLine(logPath(root), {
        id,
        time: new Date().toISOString(),
        tool: input.tool_name,
        file: rel(root, file),
        created: pending ? !pending.existed : null,
        snapshot: pending ? pending.snapshot : null,
        after
      });
    });
  }
  if (pending) fs.rmSync(pendingFile, { force: true });
}

if (id && id % TIDY_EVERY === 0) {
  const { tidyHistory } = await import('./history.mjs');
  tidyHistory(root);
}

process.exit(0);
