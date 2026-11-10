// Read and change Margin's per-project settings in .margin/settings.json.
// Usage: node settings.mjs show | set <key> <value>
import path from 'node:path';
import { projectDir, marginDir, loadSettings, writeJson, DEFAULT_SETTINGS } from './lib.mjs';

const root = projectDir();
const file = path.join(marginDir(root), 'settings.json');
const [command = 'show', key, ...rest] = process.argv.slice(2);
const settings = loadSettings(root);

if (command === 'show') {
  for (const [k, v] of Object.entries(settings)) console.log(`${k}: ${v === '' ? '(not set)' : v}`);
} else if (command === 'set') {
  if (!(key in DEFAULT_SETTINGS)) {
    console.log(`Unknown setting "${key}". Known: ${Object.keys(DEFAULT_SETTINGS).join(', ')}`);
    process.exit(1);
  }
  const raw = rest.join(' ');
  const value = typeof DEFAULT_SETTINGS[key] === 'boolean' ? ['true', 'yes', 'on', '1'].includes(raw.toLowerCase()) : raw;
  settings[key] = value;
  writeJson(file, settings);
  console.log(`${key} set to ${value === '' ? '(not set)' : value}`);
} else {
  console.log('Use "show" or "set <key> <value>".');
  process.exit(1);
}
