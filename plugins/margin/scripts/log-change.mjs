// PostToolUse hook: record every file Claude changed in .margin/log.jsonl,
// with the backup made by guard.mjs, so /margin:review can show it.
import fs from 'node:fs';
import path from 'node:path';
import { readStdinJson, projectDir, marginDir, readJson, appendLine, rel, isInside } from './lib.mjs';

const input = readStdinJson();
const root = projectDir(input);
const args = input.tool_input || {};
const file = args.file_path || args.notebook_path;

if (file && !isInside(path.resolve(root, file), marginDir(root))) {
  const pendingFile = path.join(marginDir(root), 'history', 'pending', `${input.tool_use_id}.json`);
  const pending = readJson(pendingFile, null);
  appendLine(path.join(marginDir(root), 'log.jsonl'), {
    time: new Date().toISOString(),
    tool: input.tool_name,
    file: rel(root, file),
    created: pending ? !pending.existed : null,
    snapshot: pending ? pending.snapshot : null
  });
  if (pending) fs.rmSync(pendingFile, { force: true });
}

process.exit(0);
