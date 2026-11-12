// A small stand-in for the parts of the VS Code API that the Margin companion
// uses, with a fake clock, so vscode-extension/extension.js runs unchanged under
// plain Node. No dependencies. Always dispose the world, even when a test fails:
//   const world = createWorld({ root, docs: ['drafts/ch3.md'] });
//   try { world.activate(); world.tick(10); ... } finally { world.dispose(); }
'use strict';
const Module = require('module');
const path = require('path');

const EXTENSION_DIR = path.join(__dirname, '..', 'vscode-extension');
const DEFAULT_CONFIG = { pauseSeconds: 8, stuckMinutes: 3, suggestBreaks: true, fileTypes: ['markdown', 'plaintext', 'latex'] };

class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
}
class Selection extends Range { constructor(anchor, active) { super(anchor, active); this.anchor = anchor; this.active = active; } }
const Uri = { file: (fsPath) => ({ scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` }) };

function createWorld({ root, docs = ['drafts/ch3.md'], config = {}, focused = true } = {}) {
  // Fake clock: Date.now and the timer functions, until dispose().
  let clock = Date.UTC(2026, 10, 11, 9, 0, 0);
  const real = { now: Date.now, setInterval, clearInterval, setTimeout, clearTimeout };
  const timers = new Map();
  let timerId = 0;
  const addTimer = (fn, ms, repeat) => { timers.set(++timerId, { fn, ms: Math.max(ms || 0, 1), at: clock + Math.max(ms || 0, 0), repeat }); return timerId; };
  Date.now = () => clock;
  global.setInterval = (fn, ms) => addTimer(fn, ms, true);
  global.setTimeout = (fn, ms) => addTimer(fn, ms, false);
  global.clearInterval = (id) => { timers.delete(id); };
  global.clearTimeout = (id) => { timers.delete(id); };

  const log = { setDecorations: 0, statusWrites: 0, shown: [], reveals: [], messages: [], clipboard: [], panels: [], picks: [], settingsRead: new Set() };
  const listeners = { edit: [], windowState: [], visible: [], config: [] };
  const on = (list) => (cb) => { list.push(cb); return { dispose() { const i = list.indexOf(cb); if (i >= 0) list.splice(i, 1); } }; };
  const settings = { ...DEFAULT_CONFIG, ...config };
  const relative = (fsPath) => path.relative(root, fsPath).split(path.sep).join('/');
  const answers = [];
  const commands = {};
  const watchers = [];
  const decorationTypes = [];
  const subscriptions = [];

  const documents = new Map();
  function documentAt(fsPath) {
    if (!documents.has(fsPath)) {
      const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1} of the draft.`);
      const languageId = /\.(md|markdown)$/i.test(fsPath) ? 'markdown' : /\.tex$/i.test(fsPath) ? 'latex' : /\.txt$/i.test(fsPath) ? 'plaintext' : 'javascript';
      documents.set(fsPath, { uri: Uri.file(fsPath), fileName: fsPath, languageId, lines, get lineCount() { return lines.length; }, lineAt: (n) => ({ text: lines[n] || '' }) });
    }
    return documents.get(fsPath);
  }
  // Each time a document is shown VS Code makes a new editor, with no decorations.
  function makeEditor(document) {
    return {
      document,
      selection: new Selection(new Position(10, 0), new Position(10, 0)),
      decorations: new Map(),
      setDecorations(type, ranges) { log.setDecorations++; this.decorations.set(type, ranges); },
      revealRange(range) { log.reveals.push({ file: relative(document.uri.fsPath), line: range.start.line }); }
    };
  }
  let visible = docs.map((d) => makeEditor(documentAt(path.join(root, d))));
  let active = visible[0] || null;
  const showEditors = (list, newActive) => { visible = list; active = newActive; for (const cb of [...listeners.visible]) cb(visible); };

  const status = { show() {}, dispose() {} };
  for (const key of ['text', 'tooltip', 'command']) {
    let value;
    Object.defineProperty(status, key, { get: () => value, set: (v) => { log.statusWrites++; value = v; }, enumerable: true });
  }

  const vscode = {
    Position, Range, Selection, Uri,
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(value) { this.value = value; } },
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    OverviewRulerLane: { Left: 1 }, StatusBarAlignment: { Left: 1, Right: 2 }, TextEditorRevealType: { InCenter: 2 }, ViewColumn: { Beside: -2 },
    workspace: {
      workspaceFolders: root ? [{ uri: Uri.file(root), name: path.basename(root), index: 0 }] : undefined,
      getConfiguration: (section) => ({ get: (key) => { log.settingsRead.add(`${section}.${key}`); return settings[key]; } }),
      onDidChangeTextDocument: on(listeners.edit),
      onDidChangeConfiguration: on(listeners.config),
      createFileSystemWatcher(pattern) {
        const w = { pattern: pattern.pattern, change: [], create: [], delete: [] };
        watchers.push(w);
        return { onDidChange: on(w.change), onDidCreate: on(w.create), onDidDelete: on(w.delete), dispose() {} };
      },
      openTextDocument: async (target) => documentAt(typeof target === 'string' ? target : target.fsPath)
    },
    window: {
      state: { focused },
      get visibleTextEditors() { return visible; },
      get activeTextEditor() { return active; },
      createTextEditorDecorationType(options) { const t = { options, dispose() {} }; decorationTypes.push(t); return t; },
      createStatusBarItem: () => status,
      onDidChangeWindowState: on(listeners.windowState),
      onDidChangeVisibleTextEditors: on(listeners.visible),
      showQuickPick: async (items) => {
        log.picks.push(items);
        const want = answers.shift();
        return typeof want === 'function' ? want(items) : items.find((i) => i === want || i.id === want || i.label === want);
      },
      showTextDocument: async (document) => {
        log.shown.push(relative(document.uri.fsPath));
        const editor = visible.find((e) => e.document === document) || makeEditor(document);
        showEditors(visible.includes(editor) ? visible : [...visible, editor], editor);
        return editor;
      },
      setStatusBarMessage: (text) => { log.messages.push(text); return { dispose() {} }; },
      createWebviewPanel: (viewType, title) => {
        const disposed = [];
        const panel = { title, webview: { html: '' }, onDidDispose: on(disposed), dispose() { for (const cb of [...disposed]) cb(); } };
        log.panels.push(panel);
        return panel;
      }
    },
    commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() { delete commands[id]; } }; } },
    env: { clipboard: { writeText: async (text) => { log.clipboard.push(text); } } }
  };

  const isNoteType = (t) => Boolean(t.options.gutterIconPath);
  const world = {
    vscode, log, commands, settings, status,
    get now() { return clock; },
    get editors() { return visible; },
    // Load extension.js afresh with require('vscode') answered by this mock, then activate it.
    activate() {
      const file = require.resolve(path.join(EXTENSION_DIR, 'extension.js'));
      delete require.cache[file];
      const load = Module._load;
      Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : load.call(this, request, ...rest); };
      try {
        const ext = require(file);
        ext.activate({ subscriptions, asAbsolutePath: (p) => path.join(EXTENSION_DIR, p) });
        return ext;
      } finally {
        Module._load = load;
      }
    },
    // Advance the clock one second at a time, running timers as they fall due.
    tick(seconds = 1) {
      for (let s = 0; s < seconds; s++) {
        const until = clock + 1000;
        for (;;) {
          let next = null;
          for (const [id, t] of timers) if (t.at <= until && (!next || t.at < next[1].at)) next = [id, t];
          if (!next) break;
          const [id, t] = next;
          clock = Math.max(clock, t.at);
          if (t.repeat) t.at += t.ms; else timers.delete(id);
          t.fn();
        }
        clock = until;
      }
    },
    // The writer types `text` (deleting `deleted` characters) at line `line`.
    type(text = 'x', { deleted = 0, editor = active, line = 5, character = 3 } = {}) {
      const change = { text, rangeLength: deleted, range: new Range(line, character, line, character + deleted) };
      for (const cb of [...listeners.edit]) cb({ document: editor.document, contentChanges: [change] });
    },
    focus(isFocused) { vscode.window.state = { focused: isFocused }; for (const cb of [...listeners.windowState]) cb({ focused: isFocused }); },
    open(rel) { const editor = makeEditor(documentAt(path.join(root, rel))); showEditors([...visible, editor], editor); return editor; },
    close(editor) { const rest = visible.filter((e) => e !== editor); showEditors(rest, rest.includes(active) ? active : rest[0] || null); },
    fileChanged(rel, kind = 'change') { for (const w of watchers) if (w.pattern === rel) for (const cb of [...w[kind]]) cb(Uri.file(path.join(root, rel))); },
    // The writer changes a margin.* setting; VS Code tells the extension.
    changeSetting(key, value) { settings[key] = value; for (const cb of [...listeners.config]) cb({ affectsConfiguration: (section) => section === 'margin' || section === `margin.${key}` }); },
    answer(...picks) { answers.push(...picks); },
    run: (id, ...args) => commands[id](...args),
    settle: async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); },
    // The note dots in an editor: how many, and on which lines (0-based).
    dots(editor = visible[0]) { return decorationTypes.filter(isNoteType).flatMap((t) => editor.decorations.get(t) || []).map((d) => d.range.start.line).sort((a, b) => a - b); },
    highlighted(editor) { return decorationTypes.filter((t) => t.options.isWholeLine).flatMap((t) => editor.decorations.get(t) || []).map((r) => r.start.line); },
    dispose() {
      for (const s of subscriptions.splice(0)) s.dispose();
      Date.now = real.now;
      Object.assign(global, { setInterval: real.setInterval, clearInterval: real.clearInterval, setTimeout: real.setTimeout, clearTimeout: real.clearTimeout });
    }
  };
  return world;
}

module.exports = { createWorld, EXTENSION_DIR };
