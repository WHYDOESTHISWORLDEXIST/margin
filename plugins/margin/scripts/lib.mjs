// Shared helpers for Margin's hook and command scripts. No dependencies.
import fs from 'node:fs';
import path from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

export function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function projectDir(input = {}) {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
}

export function marginDir(root) {
  return path.join(root, '.margin');
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export const DEFAULT_SETTINGS = {
  drafts: 'drafts',
  notes: 'notes',
  sources: 'sources',
  bibliography: '',
  suggestBreaks: true,
  storyLength: 'short'
};

export function loadSettings(root) {
  return { ...DEFAULT_SETTINGS, ...readJson(path.join(marginDir(root), 'settings.json'), {}) };
}

export function loadFocus(root) {
  const focus = readJson(path.join(marginDir(root), 'focus.json'), {});
  return { enabled: Boolean(focus.enabled), paths: Array.isArray(focus.paths) ? focus.paths : [] };
}

export function saveFocus(root, focus) {
  writeJson(path.join(marginDir(root), 'focus.json'), focus);
}

function normalize(p) {
  const resolved = path.resolve(p);
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

// True when `target` is `base` itself or anything below it.
export function isInside(target, base) {
  const t = normalize(target);
  const b = normalize(base);
  if (t === b) return true;
  return t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

// Project-relative path with forward slashes, for display and storage.
export function rel(root, target) {
  return path.relative(root, path.resolve(root, target)).split(path.sep).join('/') || '.';
}

export function appendLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}
