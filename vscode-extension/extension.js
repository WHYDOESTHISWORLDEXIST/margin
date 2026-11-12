// Margin Companion for VS Code.
// Reads the notes Claude queues in .margin/suggestions.json, holds new ones
// until a natural pause, then shows them as small dots in the gutter. Offers a
// break in the status bar after a long stall. It never opens a popup.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PauseTracker, BreakOffer, endsParagraph } = require('./pause');

const KIND_STYLE = {
  citation: { icon: 'dot-citation.svg', ruler: '#2F6A8A', label: 'Citation' },
  related: { icon: 'dot-related.svg', ruler: '#8A93A0', label: 'Related passage' },
  contradiction: { icon: 'dot-contradiction.svg', ruler: '#B5651D', label: 'Possible contradiction' },
  todo: { icon: 'dot-related.svg', ruler: '#8A93A0', label: 'Loose end' },
  note: { icon: 'dot-related.svg', ruler: '#8A93A0', label: 'Note' }
};
const RETURN_SPOT_MS = 30 * 60 * 1000;
const kindOf = (n) => (Object.prototype.hasOwnProperty.call(KIND_STYLE, n.kind) ? n.kind : 'note');

function activate(context) {
  const config = () => vscode.workspace.getConfiguration('margin');
  const tracker = new PauseTracker({
    pauseMs: config().get('pauseSeconds') * 1000,
    stuckMs: config().get('stuckMinutes') * 60 * 1000
  });
  const offer = new BreakOffer();
  const revealed = new Set();
  let notes = [];
  let windowFocused = vscode.window.state.focused;
  let walkReturn = null;

  const decorations = {};
  for (const [kind, style] of Object.entries(KIND_STYLE)) {
    decorations[kind] = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.file(context.asAbsolutePath(path.join('media', style.icon))),
      gutterIconSize: '60%',
      overviewRulerColor: style.ruler,
      overviewRulerLane: vscode.OverviewRulerLane.Left
    });
    context.subscriptions.push(decorations[kind]);
  }
  const returnHighlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
    isWholeLine: true
  });
  context.subscriptions.push(returnHighlight);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.show();
  context.subscriptions.push(status);
  // What the status item and each editor last showed. Nothing is re-sent while
  // it stays the same, and VS Code keeps dots in place as the writer edits.
  const statusShown = {};
  const painted = new WeakMap(); // editor -> Map(kind -> signature)

  function root() {
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    return folder ? folder.uri.fsPath : null;
  }

  function notesFile() {
    const r = root();
    return r ? path.join(r, '.margin', 'suggestions.json') : null;
  }

  function loadNotes() {
    const file = notesFile();
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      notes = (data.items || []).filter((n) => n.status === 'open');
    } catch {
      notes = [];
    }
    refresh();
  }

  // Breaks are offered only if both the VS Code setting and the project's own
  // answer from /margin:setup (suggestBreaks in .margin/settings.json) allow
  // them. A file that can't be read just now keeps the last answer.
  let projectAllowsBreaks = true;
  function loadProjectSettings() {
    const r = root();
    if (!r) return;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(r, '.margin', 'settings.json'), 'utf8').replace(/^\uFEFF/, ''));
      projectAllowsBreaks = !(data && data.suggestBreaks === false);
    } catch (e) {
      if (e.code === 'ENOENT') projectAllowsBreaks = true;
    }
  }

  function saveStatus(id, statusValue) {
    const file = notesFile();
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const item = (data.items || []).find((n) => n.id === id);
      if (item) item.status = statusValue;
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    } catch {
      // Nothing to update.
    }
  }

  // The writer's own documents; output panels and other views change too.
  function watched(doc) {
    return (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled') && config().get('fileTypes').includes(doc.languageId);
  }

  function relPath(doc) {
    const r = root();
    return r ? path.relative(r, doc.uri.fsPath).split(path.sep).join('/') : null;
  }

  // Sends an editor's dots only for the kinds whose notes changed since it last
  // showed them. A newly shown editor starts with none, so it gets all of its own.
  function paint() {
    for (const editor of vscode.window.visibleTextEditors) {
      const rel = relPath(editor.document);
      const lastLine = editor.document.lineCount - 1;
      const byKind = {};
      for (const kind of Object.keys(KIND_STYLE)) byKind[kind] = [];
      for (const n of notes) {
        if (n.file !== rel || !revealed.has(n.id)) continue;
        byKind[kindOf(n)].push({ n, line: Math.min(Math.max((n.line || 1) - 1, 0), lastLine) });
      }
      let last = painted.get(editor);
      if (!last) painted.set(editor, (last = new Map()));
      for (const [kind, list] of Object.entries(byKind)) {
        const signature = JSON.stringify(list.map(({ n, line }) => [n.id, line, n.message, n.source]));
        if ((last.get(kind) || '[]') === signature) continue;
        last.set(kind, signature);
        editor.setDecorations(decorations[kind], list.map(({ n, line }) => ({
          range: new vscode.Range(line, 0, line, 0),
          hoverMessage: new vscode.MarkdownString(`**${KIND_STYLE[kind].label}**\n\n${n.message}${n.source ? `\n\n_See ${n.source}_` : ''}`)
        })));
      }
    }
  }

  function setStatus(next) {
    for (const key of ['text', 'tooltip', 'command']) {
      if (statusShown[key] !== next[key]) status[key] = statusShown[key] = next[key];
    }
  }

  function refresh() {
    const shown = notes.filter((n) => revealed.has(n.id)).length;
    const held = notes.length - shown;
    const editor = vscode.window.activeTextEditor;
    const stalled = Boolean(config().get('suggestBreaks') && projectAllowsBreaks && editor && watched(editor.document) && tracker.isStalled());
    if (offer.update(stalled, windowFocused)) {
      setStatus({
        text: '$(coffee) Margin · break?',
        tooltip: 'A short break is here if you want one. Click to choose, or just ignore this.',
        command: 'margin.breakMenu'
      });
    } else {
      setStatus({
        text: shown ? `$(circle-small-filled) Margin · ${shown}` : '$(circle-small) Margin',
        tooltip: `${shown} margin note${shown === 1 ? '' : 's'}${held ? ` · ${held} held until your next pause` : ''}`,
        command: 'margin.notes'
      });
    }
    paint();
  }

  function revealHeld() {
    let changed = false;
    for (const n of notes) if (!revealed.has(n.id)) { revealed.add(n.id); changed = true; }
    if (changed) refresh();
  }

  // Typing rhythm.
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    if (!watched(e.document) || !e.contentChanges.length) return;
    let inserted = 0;
    let deleted = 0;
    let finished = false;
    for (const change of e.contentChanges) {
      inserted += change.text.length;
      deleted += change.rangeLength;
      const prevLine = e.document.lineAt(change.range.start.line).text.slice(0, change.range.start.character);
      if (endsParagraph(prevLine, change.text)) finished = true;
    }
    tracker.recordEdit(inserted, deleted, finished);
    offer.typed();
    walkReturn = null; // the writer is back at it
  }));

  context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
    if (state.focused === windowFocused) return; // some VS Code versions also report activity changes
    windowFocused = state.focused;
    if (!state.focused) {
      tracker.recordBlur();
      if (walkReturn) walkReturn.left = true;
    } else {
      tracker.recordFocus();
      if (walkReturn && walkReturn.walk && walkReturn.left) showReturnSpot();
    }
  }));

  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => paint()));

  // Margin's files: the notes queue, and the project's settings.
  const r = root();
  function watch(name, onChange) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(r, `.margin/${name}`));
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);
    context.subscriptions.push(watcher);
  }
  if (r) {
    watch('suggestions.json', loadNotes);
    watch('settings.json', loadProjectSettings);
  }

  // Cheap checks once a second; refresh() only touches the UI when something changed.
  const timer = setInterval(() => {
    if (tracker.isPaused()) revealHeld();
    refresh();
  }, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Break flow. The writer's place when they chose a break is highlighted when
  // they come back: from a walk, when the window has focus again; from a quiet
  // panel, when they close it. It's forgotten once they edit, and after half an hour.
  function rememberSpot(walk) {
    const editor = vscode.window.activeTextEditor;
    walkReturn = editor ? { uri: editor.document.uri, line: editor.selection.active.line, at: Date.now(), walk, left: false } : null;
  }

  async function showReturnSpot() {
    const spot = walkReturn;
    walkReturn = null;
    if (!spot || Date.now() - spot.at > RETURN_SPOT_MS) return;
    const doc = await vscode.workspace.openTextDocument(spot.uri);
    const editor = await vscode.window.showTextDocument(doc);
    const range = new vscode.Range(spot.line, 0, spot.line, 0);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.setDecorations(returnHighlight, [range]);
    setTimeout(() => editor.setDecorations(returnHighlight, []), 5000);
  }

  context.subscriptions.push(vscode.commands.registerCommand('margin.breakMenu', async () => {
    offer.clicked();
    refresh();
    const choice = await vscode.window.showQuickPick([
      { label: '$(book) A very short story', description: 'about a minute', id: 'story' },
      { label: '$(person) A short walk', description: 'five minutes away from the screen', id: 'walk' },
      { label: '$(circle-large-outline) Something quiet', description: 'shapes drifting, nothing to do', id: 'quiet' },
      { label: '$(eye) Just notice', description: 'a minute with eyes off the page', id: 'notice' },
      { label: 'Not now', id: 'none' }
    ], { placeHolder: 'A short break, if you want one' });
    if (!choice || choice.id === 'none') return;
    if (choice.id === 'story') {
      await vscode.env.clipboard.writeText('/margin:pause story');
      vscode.window.setStatusBarMessage('Copied "/margin:pause story". Paste it into Claude Code.', 6000);
    } else if (choice.id === 'walk') {
      rememberSpot(true);
      vscode.window.setStatusBarMessage('Enjoy the walk. Your place is saved.', 8000);
    } else {
      rememberSpot(false);
      openQuiet(choice.id);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('margin.quiet', () => openQuiet('quiet')));

  function openQuiet(mode) {
    const panel = vscode.window.createWebviewPanel('marginQuiet', mode === 'notice' ? 'Just notice' : 'Something quiet',
      vscode.ViewColumn.Beside, { enableScripts: true });
    panel.webview.html = quietHtml(mode);
    panel.onDidDispose(() => { if (walkReturn && !walkReturn.walk) showReturnSpot(); });
  }

  // Notes list.
  context.subscriptions.push(vscode.commands.registerCommand('margin.notes', async () => {
    revealHeld();
    if (!notes.length) {
      vscode.window.setStatusBarMessage('No margin notes right now.', 4000);
      return;
    }
    const pick = await vscode.window.showQuickPick(notes.map((n) => ({
      label: `${KIND_STYLE[kindOf(n)].label}: ${n.file}:${n.line}`,
      detail: n.message,
      note: n
    })), { placeHolder: 'Margin notes' });
    if (!pick) return;
    const action = await vscode.window.showQuickPick(['Go to it', 'Dismiss'], { placeHolder: pick.detail });
    if (action === 'Go to it') {
      const doc = await vscode.workspace.openTextDocument(path.join(root(), pick.note.file));
      const editor = await vscode.window.showTextDocument(doc);
      const pos = new vscode.Position(Math.max(pick.note.line - 1, 0), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } else if (action === 'Dismiss') {
      saveStatus(pick.note.id, 'dismissed');
      loadNotes();
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('margin.showNow', revealHeld));

  loadProjectSettings();
  loadNotes();
}

function quietHtml(mode) {
  const nonce = crypto.randomBytes(12).toString('base64');
  const body = mode === 'notice'
    ? `<p>Look away from the screen for a minute. Notice what you hear, the light in the room, how you're sitting. Nothing to get right.</p><div class="ring"></div>`
    : `<p>Watch the shapes drift. Click one if you like. There's nothing to finish.</p>
       <div class="pond">${[1, 2, 3, 4, 5, 6].map((n) => `<button class="dot d${n}" aria-label="Drifting shape"></button>`).join('')}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:24px;max-width:560px}
p{font-size:15px;line-height:1.6;color:var(--vscode-descriptionForeground)}
.pond{position:relative;height:320px;border-radius:12px;background:color-mix(in srgb,var(--vscode-textLink-foreground) 12%,transparent);overflow:hidden}
.dot{position:absolute;width:64px;height:64px;border-radius:50%;border:none;cursor:pointer;background:color-mix(in srgb,var(--vscode-textLink-foreground) 35%,transparent);animation:drift 20s ease-in-out infinite alternate;transition:opacity 1.6s,transform 1.6s}
.dot.gone{opacity:0;transform:scale(1.6)}
.d1{left:8%;top:12%}.d2{left:58%;top:8%;width:48px;height:48px;animation-duration:24s}.d3{left:30%;top:44%;width:80px;height:80px;animation-duration:28s}
.d4{left:72%;top:52%;animation-duration:22s}.d5{left:14%;top:70%;width:44px;height:44px;animation-duration:26s}.d6{left:48%;top:74%;width:56px;height:56px;animation-duration:23s}
@keyframes drift{0%{translate:0 0}50%{translate:24px -18px}100%{translate:-16px 14px}}
.ring{width:120px;height:120px;border-radius:50%;border:2px solid var(--vscode-textLink-foreground);margin:32px auto;animation:breathe 8s ease-in-out infinite}
@keyframes breathe{0%,100%{transform:scale(.8);opacity:.5}50%{transform:scale(1);opacity:1}}
@media (prefers-reduced-motion: reduce){.dot,.ring{animation:none}}
</style></head><body>${body}
<script nonce="${nonce}">document.querySelectorAll('.dot').forEach(d=>d.addEventListener('click',()=>d.classList.add('gone')));</script>
</body></html>`;
}

function deactivate() {}

module.exports = { activate, deactivate, quietHtml };
