// Read and change Margin's per-project settings in .margin/settings.json.
// Usage: node settings.mjs show | set <key> <value>
import { projectDir, readSettings, writeJsonAtomic, keepAside, rel, isSettingName, DEFAULT_SETTINGS } from './lib.mjs';

const root = projectDir();
const [command = 'show', key, ...rest] = process.argv.slice(2);
const current = readSettings(root);
const say = (line) => console.log(line);

if (command === 'show') {
  if (current.state === 'damaged') {
    say(`Margin's settings file (.margin/settings.json) is damaged (${current.problems[0]}), so these are the defaults. It will be kept aside the next time a setting is saved.`);
  }
  for (const [k, v] of Object.entries(current.settings)) say(`${k}: ${v === '' ? '(not set)' : v}`);
  if (current.state === 'ok') for (const p of current.problems) say(`Note: ${p}.`);
} else if (command === 'set') {
  if (!isSettingName(key)) {
    say(`Unknown setting "${key}". Known: ${Object.keys(DEFAULT_SETTINGS).join(', ')}`);
    process.exit(1);
  }
  const raw = rest.join(' ');
  const value = typeof DEFAULT_SETTINGS[key] === 'boolean' ? ['true', 'yes', 'on', '1'].includes(raw.toLowerCase()) : raw;
  if (current.state === 'damaged') {
    const kept = keepAside(current.file);
    say(`Margin's settings file was damaged (${current.problems[0]}), so it was kept as ${rel(root, kept)} and the other settings went back to their defaults.`);
  } else {
    for (const p of current.problems) say(`Note: ${p}; the default is used instead.`);
  }
  writeJsonAtomic(current.file, { ...current.extra, ...current.settings, [key]: value });
  say(`${key} set to ${value === '' ? '(not set)' : value}`);
} else {
  say('Use "show" or "set <key> <value>".');
  process.exit(1);
}
