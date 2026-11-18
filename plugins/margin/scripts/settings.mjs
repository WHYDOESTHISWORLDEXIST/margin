// Read and change Margin's per-project settings in .margin/settings.json.
// Usage: node settings.mjs show | set <key> <value> | init | ensure
//   init     used by /margin:setup: sets Margin up here (keeping earlier answers) and says where
//   ensure   used first by every other command that changes something: sets Margin up here
//            if it isn't yet, and prints nothing when it already is
import { projectDir, scriptArgs, readSettings, writeJsonAtomic, keepAside, rel, isSettingName, parseSetting, settingHint, DEFAULT_SETTINGS } from './lib.mjs';

const root = projectDir();
const [command = 'show', key, ...rest] = scriptArgs();
const current = readSettings(root);
const say = (line) => console.log(line);

function keepDamagedAside() {
  const kept = keepAside(current.file);
  say(`Margin's settings file was damaged (${current.problems[0]}), so it was kept as ${rel(root, kept)} and the other settings went back to their defaults.`);
}

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
  const value = parseSetting(key, raw);
  if (value === undefined) {
    say(`${key} takes ${settingHint(key)}, not "${raw}". Nothing was changed.`);
    process.exit(1);
  }
  if (current.state === 'damaged') keepDamagedAside();
  else for (const p of current.problems) say(`Note: ${p}; the default is used instead.`);
  writeJsonAtomic(current.file, { ...current.extra, ...current.settings, [key]: value });
  say(`${key} set to ${value === '' ? '(not set)' : value}`);
} else if (command === 'init' || command === 'ensure') {
  if (current.state !== 'ok') {
    if (current.state === 'damaged') keepDamagedAside();
    writeJsonAtomic(current.file, { ...current.extra, ...current.settings });
    say(`Margin is now set up in ${root}.`);
  } else if (command === 'init') {
    say(`Margin is set up in ${root}.`);
  }
} else {
  say('Use "show", "set <key> <value>", "init" or "ensure".');
  process.exit(1);
}
