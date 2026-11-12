// What a shell command would read, as far as can be told without running it.
// Loaded by shell-guard.mjs only while focus is on.
//
// classify(command, { dialect: 'bash' | 'powershell', cwd, scriptsDir }) returns
//   reads     files a known reader (cat, head, Get-Content, ...) would open
//   searches  folders a recursive search (grep -r, rg, find -exec, ...) would cover
//   named     existing paths that an interpreter one-liner or an unknown program names
//   unknown   reader operands that can't be worked out ($VAR, $(...), names from a pipe)
// Listing names (ls, find, Get-ChildItem), echo/printf text and Margin's own
// scripts read nothing. Each entry is { path | dir | word, program }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
const MAX_DEPTH = 3;

// --------------------------------------------------------------------------
// Programs
// --------------------------------------------------------------------------

const POSIX_READERS = new Set([
  'cat', 'tac', 'nl', 'head', 'tail', 'less', 'more', 'most', 'bat', 'batcat', 'od', 'xxd', 'hexdump', 'strings',
  'base64', 'base32', 'wc', 'sort', 'uniq', 'cut', 'paste', 'diff', 'diff3', 'sdiff', 'cmp', 'comm', 'iconv', 'jq', 'yq',
  'column', 'fold', 'fmt', 'expand', 'unexpand', 'rev', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'shasum', 'cksum',
  'sed', 'awk', 'gawk', 'mawk', 'nawk', 'zcat', 'gzcat', 'bzcat', 'xzcat', 'cp', 'join', 'pr', 'csplit', 'split', 'dd',
  'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'ugrep'
]);
const PS_READERS = new Set([
  'get-content', 'gc', 'cat', 'type', 'select-string', 'sls', 'import-csv', 'ipcsv', 'import-clixml', 'format-hex', 'fhx',
  'copy-item', 'copy', 'cp', 'cpi', 'more', 'findstr',
  // Git for Windows puts these on PATH, so PowerShell can run them too.
  'head', 'tail', 'less', 'nl', 'tac', 'od', 'xxd', 'strings', 'wc', 'cut', 'cmp', 'comm', 'jq', 'sed', 'awk', 'gawk',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ugrep', 'iconv', 'base64', 'md5sum', 'sha1sum', 'sha256sum', 'bat', 'dd'
]);
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'ugrep', 'findstr', 'select-string', 'sls']);
const SEARCH_BY_DEFAULT = new Set(['rg', 'ag', 'ack', 'ugrep']);
const LISTERS = new Set(['ls', 'dir', 'vdir', 'tree', 'find', 'gfind', 'fd', 'fdfind', 'get-childitem', 'gci', 'get-item', 'gi']);
// Programs that don't show file contents to Claude.
const QUIET = new Set([
  'echo', 'printf', 'true', 'false', 'test', '[', '[[', ':', 'pwd', 'stat', 'du', 'df', 'file', 'which', 'whereis',
  'realpath', 'readlink', 'basename', 'dirname', 'mkdir', 'rmdir', 'touch', 'rm', 'mv', 'ln', 'chmod', 'chown', 'chgrp',
  'open', 'xdg-open', 'start', 'code', 'explorer', 'sleep', 'date', 'clear', 'export', 'unset', 'alias', 'read', 'wait',
  'kill', 'ps', 'whoami', 'hostname', 'uname', 'history', 'exit', 'return', 'set', 'shopt', 'popd', 'tee', 'tr', 'seq',
  'locate', 'popd', 'trap', 'local', 'declare', 'readonly', 'type' /* bash builtin; PowerShell's type is a reader */,
  'write-output', 'write', 'write-host', 'out-host', 'out-null', 'out-string', 'out-file', 'set-content', 'sc',
  'add-content', 'ac', 'new-item', 'ni', 'md', 'remove-item', 'ri', 'del', 'erase', 'rd', 'move-item', 'mi', 'move',
  'rename-item', 'ren', 'rni', 'test-path', 'resolve-path', 'rvpa', 'split-path', 'join-path', 'get-location', 'gl',
  'pop-location', 'select-object', 'select', 'where-object', 'where', '?', 'foreach-object', 'foreach', '%', 'sort-object',
  'measure-object', 'measure', 'format-table', 'ft', 'format-list', 'fl', 'get-date', 'start-sleep', 'invoke-item', 'ii',
  'start-process', 'saps', 'get-command', 'gcm', 'get-help', 'clear-host', 'cls', 'get-filehash', 'compare-object',
  'get-process', 'gps', 'get-service', 'get-variable', 'set-variable', 'new-object', 'add-type', 'out-default'
]);
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const KEYWORDS = new Set(['!', '{', '}', 'then', 'do', 'done', 'else', 'elif', 'if', 'fi', 'esac', 'while', 'until', 'time', 'exec', 'command', 'builtin', 'nohup', 'coproc', 'function']);
// PowerShell's own readers take -Path style parameters; the rest are external programs.
const PS_NATIVE_READERS = new Set(['get-content', 'gc', 'cat', 'type', 'import-csv', 'ipcsv', 'import-clixml', 'format-hex', 'fhx', 'copy-item', 'copy', 'cp', 'cpi', 'more', 'findstr']);
const LOOP_HEADERS = new Set(['for', 'case', 'select']);
const WRAPPERS = { sudo: ['-u', '-g', '-C', '-h', '-p'], env: ['-u', '-C', '-S'], nice: ['-n'], ionice: ['-c', '-n', '-p'], stdbuf: [], timeout: ['-s', '-k'] };
const SHELLS = { bash: 'bash', sh: 'bash', zsh: 'bash', dash: 'bash', ksh: 'bash', ash: 'bash', pwsh: 'powershell', powershell: 'powershell', cmd: 'powershell' };
const INLINE_CODE = {
  node: ['-e', '--eval', '-p', '--print'], bun: ['-e', '--eval', '-p', '--print'], deno: ['eval'],
  python: ['-c'], python3: ['-c'], python2: ['-c'], py: ['-c'], pypy: ['-c'], pypy3: ['-c'],
  ruby: ['-e'], perl: ['-e', '-E'], php: ['-r'], rscript: ['-e'], lua: ['-e'], osascript: ['-e'], julia: ['-e']
};
// Options whose value is the next word (so it isn't taken for a file).
const OPT_VALUES = {
  head: ['-n', '-c'], tail: ['-n', '-c'], sort: ['-k', '-t', '-T', '-S', '--key', '--field-separator'], cut: ['-d', '-f', '-c', '-b'],
  grep: ['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--context'],
  rg: ['-e', '-f', '-g', '-m', '-A', '-B', '-C', '-t', '-T', '-j', '-M', '--glob', '--type', '--type-not', '--max-count', '--regexp', '--file', '--threads', '--sort', '--sortr'],
  ag: ['-G', '-m', '-A', '-B', '-C', '--ignore', '--file-search-regex'], ack: ['--type', '-m'], ugrep: ['-e', '-f', '-m', '-A', '-B', '-C', '-g', '-t'],
  sed: ['-e', '-f', '-l', '--expression', '--file'], awk: ['-f', '-v', '-F', '--file', '--assign', '--field-separator'],
  diff: ['-U', '-C', '-x', '-X', '--exclude'], od: ['-t', '-N', '-j', '-A', '-w'], xxd: ['-l', '-s', '-c', '-g', '-o'],
  hexdump: ['-n', '-s', '-e', '-f'], jq: ['--indent', '-f', '--from-file'], paste: ['-d'], base64: ['-w'], iconv: ['-f', '-t'],
  fold: ['-w'], fmt: ['-w'], join: ['-1', '-2', '-t', '-o'], split: ['-l', '-b', '-n'], nl: ['-b', '-w', '-s', '-v', '-i'],
  bat: ['-l', '-r', '-H', '--language', '--line-range', '--highlight-line', '--theme', '--style'], cmp: ['-n', '-i'],
  column: ['-s', '-t'], strings: ['-n', '-t'], less: ['-p', '-x'], tac: ['-s'], cp: ['-t', '-S', '--target-directory', '--suffix']
};
for (const alias of ['egrep', 'fgrep', 'zgrep']) OPT_VALUES[alias] = OPT_VALUES.grep;
for (const alias of ['gawk', 'mawk', 'nawk']) OPT_VALUES[alias] = OPT_VALUES.awk;
const PS_SWITCHES = new Set(['-recurse', '-file', '-directory', '-force', '-name', '-hidden', '-readonly', '-system', '-followsymlink',
  '-raw', '-wait', '-asbytestream', '-simplematch', '-casesensitive', '-quiet', '-list', '-notmatch', '-allmatches', '-container', '-passthru']);
const PS_PATH_PARAMS = new Set(['-path', '-literalpath', '-pspath', '-lp']);

// --------------------------------------------------------------------------
// Tokenizing: a command line becomes simple commands
//   { words: [{ text, dynamic, glob }], inputs: [word], heredocs: [text], pipedFrom }
// dynamic: part of the word is only known when the shell runs ($VAR, $(...)).
// --------------------------------------------------------------------------

function tokenize(src, dialect, vars, depth) {
  const ps = dialect === 'powershell';
  const commands = [];
  const n = src.length;
  let cmd = newCommand(null);
  let word = null;
  let pending = null;          // redirect waiting for its target word
  let heredocStrip = false;
  const heredocs = [];         // [{ delim, strip, cmd }] waiting for the next line
  let i = 0;

  function newCommand(pipedFrom) { return { words: [], inputs: [], heredocs: [], pipedFrom }; }
  function startWord() { if (!word) word = { text: '', dynamic: false, glob: false, onlyVar: null }; }
  function endWord() {
    if (!word) return;
    const w = word;
    word = null;
    if (pending) {
      const r = pending;
      pending = null;
      if (r === 'in') cmd.inputs.push(w);
      else if (r === 'here') heredocs.push({ delim: w.text, strip: heredocStrip, cmd });
      return; // output targets, here-strings and fd numbers aren't reads
    }
    cmd.words.push(w);
  }
  function endCommand(piped) {
    endWord();
    pending = null;
    const done = cmd.words.length || cmd.inputs.length || heredocs.some((h) => h.cmd === cmd);
    if (done) { commands.push(cmd); remember(cmd); }
    cmd = newCommand(piped && cmd.words.length ? cmd : null);
  }
  // NAME=value (bash) or $name = value (PowerShell) on its own sets a variable.
  function remember(c) {
    const words = c.words[0] && /^(export|declare|local|readonly)$/.test(c.words[0].text) ? c.words.slice(1) : c.words;
    if (!ps && words.length && words.every((w) => /^[A-Za-z_]\w*=/.test(w.text))) {
      for (const w of words) {
        const eq = w.text.indexOf('=');
        if (w.dynamic) delete vars[w.text.slice(0, eq)]; else vars[w.text.slice(0, eq)] = w.text.slice(eq + 1);
      }
    }
    if (ps && words.length === 3 && words[0].onlyVar && words[1].text === '=') {
      if (words[2].dynamic) delete vars[words[0].onlyVar]; else vars[words[0].onlyVar] = words[2].text;
    }
  }
  function nested(text) {
    if (depth < MAX_DEPTH) commands.push(...tokenize(text, dialect, vars, depth + 1));
  }
  function substitute(name) {
    const key = ps ? name.toLowerCase() : name;
    const wasEmpty = !word.text && !word.dynamic;
    if (key === 'HOME' || key === 'home' || key === 'env:home' || key === 'env:userprofile') { word.text += os.homedir(); return; }
    if (Object.prototype.hasOwnProperty.call(vars, key)) { word.text += vars[key]; return; }
    word.dynamic = true;
    if (wasEmpty) word.onlyVar = key;
  }
  function findClose(j, open, close) {
    let level = 0;
    for (; j < n; j++) {
      const c = src[j];
      if (c === (ps ? '`' : '\\')) { j++; continue; }
      if (c === "'") { const e = src.indexOf("'", j + 1); j = e < 0 ? n : e; continue; }
      if (c === '"') { j++; while (j < n && src[j] !== '"') { if (src[j] === (ps ? '`' : '\\')) j++; j++; } continue; }
      if (c === open) level++;
      else if (c === close && --level === 0) return j;
    }
    return n;
  }
  function readDollar(j) {
    const next = src[j + 1];
    if (next === '(') {
      const end = findClose(j + 1, '(', ')');
      if (src[j + 2] !== '(') nested(src.slice(j + 2, end));
      word.dynamic = true;
      return end + 1;
    }
    if (next === '{') {
      const end = src.indexOf('}', j + 2);
      const stop = end < 0 ? n : end;
      substitute(src.slice(j + 2, stop));
      return stop + 1;
    }
    const m = (ps ? /^(?:env:)?[A-Za-z_][\w]*|^[_?^$]/ : /^[A-Za-z_]\w*|^[0-9@*#?$!-]/).exec(src.slice(j + 1, j + 80));
    if (m) { substitute(m[0]); return j + 1 + m[0].length; }
    word.text += '$';
    return j + 1;
  }
  function readBacktickCommand(j) {
    let e = j + 1;
    while (e < n && src[e] !== '`') { if (src[e] === '\\') e++; e++; }
    nested(src.slice(j + 1, Math.min(e, n)));
    word.dynamic = true;
    return e + 1;
  }
  function readHeredocBodies() {
    while (heredocs.length) {
      const h = heredocs.shift();
      const lines = [];
      while (i < n) {
        const eol = src.indexOf('\n', i);
        const end = eol < 0 ? n : eol;
        const line = src.slice(i, end).replace(/\r$/, '');
        i = end + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        lines.push(line);
      }
      h.cmd.heredocs.push(lines.join('\n'));
    }
  }

  while (i < n) {
    const c = src[i];
    if (c === '\n') { endCommand(false); i++; if (!ps) readHeredocBodies(); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    if (ps) {
      if (!word && c === '<' && src[i + 1] === '#') { const e = src.indexOf('#>', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (!word && c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '`') { if (src[i + 1] === '\n') { i += 2; continue; } startWord(); word.text += src[i + 1] ?? ''; i += 2; continue; }
      if (!word && c === '@' && (src[i + 1] === "'" || src[i + 1] === '"') && /^\r?\n/.test(src.slice(i + 2, i + 4))) {
        const q = src[i + 1];
        const bodyStart = src.indexOf('\n', i) + 1;
        const e = src.indexOf(`\n${q}@`, bodyStart - 1);
        const stop = e < 0 ? n : e;
        startWord();
        word.text += src.slice(bodyStart, stop).replace(/\r$/, '');
        if (q === '"' && word.text.includes('$')) word.dynamic = true;
        i = e < 0 ? n : e + 3;
        continue;
      }
      if (c === "'") {
        startWord();
        let j = i + 1;
        while (j < n) { if (src[j] === "'") { if (src[j + 1] === "'") { word.text += "'"; j += 2; continue; } break; } word.text += src[j]; j++; }
        i = j + 1;
        continue;
      }
      if (c === '"') {
        startWord();
        let j = i + 1;
        while (j < n && src[j] !== '"') {
          if (src[j] === '`') { word.text += src[j + 1] ?? ''; j += 2; continue; }
          if (src[j] === '$') { j = readDollar(j); continue; }
          word.text += src[j]; j++;
        }
        i = j + 1;
        continue;
      }
      if (c === '$') { startWord(); i = readDollar(i); continue; }
      if (c === '|') { if (src[i + 1] === '|') { endCommand(false); i += 2; } else { endCommand(true); i++; } continue; }
      if (c === '&') {
        if (src[i + 1] === '&') { endCommand(false); i += 2; continue; }
        if (!word && !cmd.words.length) { i++; continue; } // the call operator: & "C:\tool.exe" args
        endCommand(false); i++; continue;
      }
      if (c === '(' && (word || cmd.words.length)) { // (subexpression) as an argument: its value is only known when it runs
        endWord(); startWord(); const end = findClose(i, '(', ')'); nested(src.slice(i + 1, end)); word.dynamic = true; i = end + 1; continue;
      }
      if (c === ';' || c === '{' || c === '}' || c === '(' || c === ')') { endCommand(false); i++; continue; }
      if (c === ',') { endWord(); i++; continue; }
      if (c === '>') {
        if (word && /^(\d|\*)$/.test(word.text)) word = null; else endWord();
        if (src[i + 1] === '&') { pending = 'fd'; i += 2; continue; }
        pending = 'out'; i += src[i + 1] === '>' ? 2 : 1; continue;
      }
      if (c === '<') { endWord(); pending = 'in'; i++; continue; }
    } else {
      if (!word && c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '\\') { if (src[i + 1] === '\n') { i += 2; continue; } startWord(); word.text += src[i + 1] ?? ''; i += 2; continue; }
      if (c === "'") { startWord(); const e = src.indexOf("'", i + 1); const stop = e < 0 ? n : e; word.text += src.slice(i + 1, stop); i = stop + 1; continue; }
      if (c === '"') {
        startWord();
        let j = i + 1;
        while (j < n && src[j] !== '"') {
          if (src[j] === '\\' && '"\\$`\n'.includes(src[j + 1])) { if (src[j + 1] !== '\n') word.text += src[j + 1]; j += 2; continue; }
          if (src[j] === '$') { j = readDollar(j); continue; }
          if (src[j] === '`') { j = readBacktickCommand(j); continue; }
          word.text += src[j]; j++;
        }
        i = j + 1;
        continue;
      }
      if (c === '$') { startWord(); if (src[i + 1] === "'") { const e = src.indexOf("'", i + 2); const stop = e < 0 ? n : e; word.text += src.slice(i + 2, stop); i = stop + 1; } else i = readDollar(i); continue; }
      if (c === '`') { startWord(); i = readBacktickCommand(i); continue; }
      if (c === '|') { if (src[i + 1] === '|') { endCommand(false); i += 2; } else { endCommand(true); i += src[i + 1] === '&' ? 2 : 1; } continue; }
      if (c === '&') {
        if (src[i + 1] === '&') { endCommand(false); i += 2; continue; }
        if (src[i + 1] === '>') { endWord(); pending = 'out'; i += src[i + 2] === '>' ? 3 : 2; continue; }
        endCommand(false); i++; continue;
      }
      if (c === ';') { endCommand(false); i += src[i + 1] === ';' ? 2 : 1; continue; }
      if (c === ')' || (c === '(' && !word)) { endCommand(false); i++; continue; }
      if (c === '<' && src[i + 1] === '(' ) { // process substitution <(cmd): the inner command runs
        startWord(); const end = findClose(i + 1, '(', ')'); nested(src.slice(i + 2, end)); word.dynamic = true; i = end + 1; continue;
      }
      if (c === '<' || c === '>') {
        if (word && /^\d+$/.test(word.text) && !word.dynamic) word = null; else endWord();
        const ahead = src.slice(i, i + 3);
        if (ahead.startsWith('<<<')) { pending = 'herestring'; i += 3; }
        else if (ahead.startsWith('<<-')) { pending = 'here'; heredocStrip = true; i += 3; }
        else if (ahead.startsWith('<<')) { pending = 'here'; heredocStrip = false; i += 2; }
        else if (ahead.startsWith('<&') || ahead.startsWith('>&')) { pending = 'fd'; i += 2; }
        else if (ahead.startsWith('<>')) { pending = 'in'; i += 2; }
        else if (ahead.startsWith('>>') || ahead.startsWith('>|')) { pending = 'out'; i += 2; }
        else { pending = c === '<' ? 'in' : 'out'; i++; }
        continue;
      }
      if (c === '~' && !word && (i + 1 >= n || /[\s/;|&)]/.test(src[i + 1]))) { startWord(); word.text += os.homedir(); i++; continue; }
      if (c === '{' || c === '}') { startWord(); word.text += c; if (word.text !== c) word.glob = true; i++; continue; }
    }
    startWord();
    if (c === '*' || c === '?' || c === '[') word.glob = true;
    word.text += c;
    i++;
  }
  endCommand(false);
  return commands;
}

// --------------------------------------------------------------------------
// Classifying
// --------------------------------------------------------------------------

function programName(text) {
  return text.split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
}

function resolvePath(text, cwd) {
  let t = text;
  if (!t || t.length > 1024 || t.includes('\0')) return null;
  if (IS_WINDOWS) { const m = /^\/([a-zA-Z])(?:\/|$)(.*)$/.exec(t); if (m) t = `${m[1]}:/${m[2]}`; } // Git Bash: /c/Users/... is C:/Users/...
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) t = path.join(os.homedir(), t.slice(1));
  if (path.isAbsolute(t)) return path.resolve(t);
  return cwd ? path.resolve(cwd, t) : null;
}

const statOf = (p) => { try { return fs.statSync(p); } catch { return null; } };

// The folder part of a wildcard path ("notes/*.md" -> "notes", "*/x.md" -> ".").
function globFolder(text) {
  const parts = text.split(/[\\/]/);
  const fixed = [];
  for (const part of parts) { if (/[*?[{]/.test(part)) break; fixed.push(part); }
  return fixed.length ? fixed.join('/') || '/' : '.';
}

export function classify(command, { dialect = 'bash', cwd = null, scriptsDir = null } = {}) {
  const out = { reads: [], searches: [], named: [], unknown: [] };
  const scriptsReal = scriptsDir ? safeReal(scriptsDir) : null;
  run(command, dialect, cwd, 0);
  return out;

  function safeReal(p) { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }

  function run(text, dl, startCwd, depth) {
    let here = startCwd;
    for (const c of tokenize(text, dl, {}, 0)) {
      const next = one(c, dl, here, depth);
      if (next !== undefined) here = next;
    }
  }

  // A word a reader would open: a file, a folder searched recursively, or a wildcard.
  function readTarget(w, cwd, program, recursive) {
    if (w.dynamic) { out.unknown.push({ word: w.text || '(a variable)', program }); return; }
    if (w.glob) {
      const dir = resolvePath(globFolder(w.text), cwd);
      if (dir === null) { out.unknown.push({ word: w.text, program }); return; }
      if (statOf(dir)) out.searches.push({ dir, program });
      return;
    }
    const p = resolvePath(w.text, cwd);
    if (p === null) { out.unknown.push({ word: w.text, program }); return; }
    const st = statOf(p);
    if (!st) return;
    if (st.isDirectory()) { if (recursive) out.searches.push({ dir: p, program }); return; }
    out.reads.push({ path: p, program });
  }

  // Existing paths an interpreter or unknown program names: the writer is asked.
  // Only words that look like paths count, so "npm test" or "make docs" don't
  // prompt just because a folder of that name exists.
  function named(w, cwd, program) {
    if (w.dynamic || !w.text) return;
    let text = w.text;
    if (/^-/.test(text)) { const eq = text.indexOf('='); if (eq < 0) return; text = text.slice(eq + 1); }
    if (!/[\\/]/.test(text) && !/^\.\.?$/.test(text) && !/\.[A-Za-z0-9]{1,8}$/.test(text)) return;
    const p = resolvePath(w.glob ? globFolder(text) : text, cwd);
    if (p !== null && statOf(p)) out.named.push({ path: p, program });
  }

  // String literals in inline code that name existing files.
  function scanCode(code, cwd, program) {
    let count = 0;
    for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      if (++count > 64) break;
      const text = m[2].replace(/\\\\/g, '\\').trim();
      if (text && text.length < 300) named({ text, dynamic: false, glob: false }, cwd, program);
    }
  }

  // Roots a listing command covers: its folder operands, else its working folder.
  function listerRoots(c, cwd, ps) {
    const words = c.words.slice(1);
    const roots = [];
    if (ps) {
      const a = psArgs(words);
      for (const name of PS_PATH_PARAMS) for (const w of a.named[name] || []) roots.push(w);
      roots.push(...a.positional);
    } else {
      let expr = false;
      for (const w of words) {
        if (expr || /^[-(!]/.test(w.text)) { expr = true; continue; }
        roots.push(w);
      }
    }
    return roots.length ? roots : [{ text: '.', dynamic: false, glob: false }];
  }

  function one(c, dl, cwd, depth) {
    const ps = dl === 'powershell';
    for (const w of c.inputs) readTarget(w, cwd, '<', false);
    let words = stripPrefix(c.words);
    if (!words.length) return undefined;
    if (LOOP_HEADERS.has(words[0].text)) return undefined;
    const progWord = words[0];
    const args = words.slice(1);
    if (progWord.dynamic) { for (const w of args) named(w, cwd, progWord.text || 'a program'); return undefined; }
    const prog = programName(progWord.text);

    if (CD.has(prog)) {
      const target = ps ? (psArgs(args).named['-path']?.[0] || psArgs(args).positional[0]) : args.find((w) => !/^-/.test(w.text) || w.text === '-');
      if (!target) return ps ? undefined : os.homedir();
      if (target.dynamic || target.text === '-') return null;
      return resolvePath(target.text, cwd);
    }
    if (prog === 'node' && isMarginScript(args, cwd)) return undefined;

    if (SHELLS[prog]) {
      const code = inlineShellCode(prog, args);
      const inner = SHELLS[prog];
      if (code !== null) {
        if (depth < MAX_DEPTH) run(code, inner, cwd, depth + 1); else out.unknown.push({ word: code, program: prog });
        return undefined;
      }
      for (const h of c.heredocs) if (depth < MAX_DEPTH) run(h, inner, cwd, depth + 1);
      for (const w of args) named(w, cwd, prog);
      return undefined;
    }
    if (INLINE_CODE[prog]) {
      const flags = INLINE_CODE[prog];
      for (let k = 0; k < args.length; k++) {
        if (flags.includes(args[k].text.toLowerCase()) && args[k + 1]) { scanCode(args[k + 1].text, cwd, prog); k++; continue; }
        named(args[k], cwd, prog);
      }
      for (const h of c.heredocs) scanCode(h, cwd, prog);
      return undefined;
    }
    if (prog === 'xargs') { xargs(c, args, dl, cwd, depth); return undefined; }
    if (prog === 'find' || prog === 'gfind') {
      if (args.some((w) => /^-(exec|execdir|ok|okdir)$/.test(w.text))) {
        for (const r of listerRoots(c, cwd, false)) readTarget(r, cwd, 'find -exec', true);
      }
      return undefined;
    }
    if (LISTERS.has(prog) || (QUIET.has(prog) && !(ps && PS_READERS.has(prog)))) return undefined;

    const readers = ps ? PS_READERS : POSIX_READERS;
    if (!readers.has(prog)) { for (const w of args) named(w, cwd, prog); return undefined; }

    if (prog === 'dd') { for (const w of args) if (w.text.startsWith('if=')) readTarget({ ...w, text: w.text.slice(3) }, cwd, prog, false); return undefined; }
    if (ps && (prog === 'select-string' || prog === 'sls')) {
      const a = psArgs(args);
      const paths = [...(a.named['-path'] || []), ...(a.named['-literalpath'] || [])];
      const positional = a.named['-pattern'] ? a.positional : a.positional.slice(1);
      paths.push(...positional);
      if (!paths.length) pipedSearch(c, cwd, prog, true, dl);
      for (const w of paths) readTarget(w, cwd, prog, false);
      return undefined;
    }
    if (ps && prog === 'findstr') {
      const recursive = args.some((w) => /^\/s$/i.test(w.text));
      const operands = args.filter((w) => !w.text.startsWith('/'));
      const files = args.some((w) => /^\/[cg]:/i.test(w.text)) ? operands : operands.slice(1);
      if (!files.length) pipedSearch(c, cwd, prog, false, dl);
      for (const w of files) readTarget(w, cwd, prog, recursive);
      return undefined;
    }
    if (ps && PS_NATIVE_READERS.has(prog)) {
      const a = psArgs(args);
      const paths = [];
      for (const name of PS_PATH_PARAMS) paths.push(...(a.named[name] || []));
      paths.push(...(['copy-item', 'copy', 'cp', 'cpi'].includes(prog) ? a.positional.slice(0, 1) : a.positional));
      if (!paths.length) pipedSearch(c, cwd, prog, true, dl);
      for (const w of paths) readTarget(w, cwd, prog, false);
      return undefined;
    }

    // POSIX-style reader.
    const opts = OPT_VALUES[prog] || [];
    const operands = [];
    const named_ = new Map();
    let endOfOptions = false;
    for (let k = 0; k < args.length; k++) {
      const w = args[k];
      if (!endOfOptions && w.text === '--') { endOfOptions = true; continue; }
      if (!endOfOptions && w.text.length > 1 && w.text.startsWith('-') && !w.dynamic) {
        const eq = w.text.indexOf('=');
        const flag = eq > 0 ? w.text.slice(0, eq) : w.text;
        if (eq > 0) { named_.set(flag, [...(named_.get(flag) || []), { ...w, text: w.text.slice(eq + 1) }]); continue; }
        if (opts.includes(flag) && args[k + 1]) { named_.set(flag, [...(named_.get(flag) || []), args[k + 1]]); k++; }
        else named_.set(flag, named_.get(flag) || []);
        continue;
      }
      operands.push(w);
    }
    const has = (...flags) => flags.some((f) => named_.has(f));
    if (SEARCHERS.has(prog)) {
      for (const w of [...(named_.get('-f') || []), ...(named_.get('--file') || [])]) readTarget(w, cwd, prog, false);
      const files = has('-e', '--regexp', '-f', '--file') ? operands : operands.slice(1);
      const recursive = SEARCH_BY_DEFAULT.has(prog) || [...named_.keys()].some((f) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(f) && !f.startsWith('--')) ||
        has('--recursive', '--dereference-recursive') || (named_.get('-d') || []).some((w) => w.text === 'recurse') || (named_.get('--directories') || []).some((w) => w.text === 'recurse');
      if (!files.length && recursive) readTarget({ text: '.', dynamic: false, glob: false }, cwd, prog, true);
      for (const w of files) readTarget(w, cwd, prog, recursive);
      return undefined;
    }
    let files = operands;
    if (prog === 'sed') { for (const w of [...(named_.get('-f') || []), ...(named_.get('--file') || [])]) readTarget(w, cwd, prog, false); if (!has('-e', '--expression', '-f', '--file')) files = operands.slice(1); }
    if (['awk', 'gawk', 'mawk', 'nawk'].includes(prog)) { for (const w of [...(named_.get('-f') || []), ...(named_.get('--file') || [])]) readTarget(w, cwd, prog, false); if (!has('-f', '--file')) files = operands.slice(1); }
    if (prog === 'cp' && !has('-t', '--target-directory')) files = operands.slice(0, -1);
    for (const w of files) readTarget(w, cwd, prog, false);
    return undefined;
  }

  // xargs runs a command on names it reads from its input.
  function xargs(c, args, dl, cwd, depth) {
    const withValue = ['-n', '-L', '-P', '-I', '-d', '-E', '-s', '-a', '--max-args', '--delimiter', '--arg-file'];
    let k = 0;
    while (k < args.length && args[k].text.startsWith('-')) { if (withValue.includes(args[k].text)) k++; k++; }
    const inner = args.slice(k);
    if (!inner.length) return;
    const innerProg = programName(inner[0].text);
    one({ words: inner, inputs: [], heredocs: [], pipedFrom: null }, dl, cwd, depth);
    const readers = dl === 'powershell' ? PS_READERS : POSIX_READERS;
    if (readers.has(innerProg)) pipedSearch(c, cwd, `xargs ${innerProg}`, false, dl);
  }

  // A reader fed names by a listing (find ... | xargs cat, gci -Recurse | Select-String)
  // covers the listing's folders; fed by anything else, Margin can't tell.
  function pipedSearch(c, cwd, program, onlyIfListing, dl) {
    const from = c.pipedFrom;
    const fromProg = from && from.words[0] && !from.words[0].dynamic ? programName(from.words[0].text) : null;
    if (fromProg && LISTERS.has(fromProg)) {
      for (const r of listerRoots(from, cwd, dl === 'powershell')) readTarget(r, cwd, program, true);
      return;
    }
    if (!onlyIfListing) out.unknown.push({ word: 'names read from its input', program });
  }

  function isMarginScript(args, cwd) {
    if (!scriptsReal) return false;
    const script = args.find((w) => !w.text.startsWith('-'));
    if (!script || script.dynamic) return false;
    const p = resolvePath(script.text, cwd);
    if (!p) return false;
    const real = safeReal(p);
    const rel = path.relative(scriptsReal, real);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && /\.mjs$/i.test(real);
  }
}

// What the shell guard answers for a command, given the focus rules (lib.focusRules):
// null to allow, or { decision: 'deny' | 'ask', reason }. Known reads outside the
// list are denied with the same words as Read; uncertain cases ask the writer.
export function decide(command, { dialect, cwd, scriptsDir, root, rules }) {
  const found = classify(command, { dialect, cwd, scriptsDir });
  const show = (p) => {
    const r = path.relative(root, p);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p;
  };
  const once = (list, key) => { const seen = new Set(); return list.filter((x) => !seen.has(x[key]) && seen.add(x[key])); };
  for (const r of once(found.reads, 'path')) { const reason = rules.reasonFor(r.path); if (reason) return { decision: 'deny', reason }; }
  for (const s of once(found.searches, 'dir')) { const reason = rules.searchReasonFor(s.dir); if (reason) return { decision: 'deny', reason }; }
  for (const n of once(found.named, 'path')) {
    if (rules.reasonFor(n.path)) {
      return { decision: 'ask', reason: `Margin focus is on, and this command (${n.program}) names ${show(n.path)}, which isn't in the focus list (${rules.list}). Allow it only if Claude reading that is fine.` };
    }
  }
  for (const u of found.unknown) {
    return { decision: 'ask', reason: `Margin focus is on, and Margin can't tell which files ${u.program} reads here (${u.word}). Allow it only if it stays within the focus list (${rules.list}).` };
  }
  return null;
}

// Leading keywords, wrappers (sudo, env, nice, timeout ...) and NAME=value prefixes.
function stripPrefix(words) {
  let k = 0;
  for (;;) {
    const w = words[k];
    if (!w) break;
    const t = w.text;
    if (KEYWORDS.has(t) && !w.dynamic) { k++; continue; }
    if (/^[A-Za-z_]\w*=/.test(t)) { k++; continue; }
    const p = programName(t);
    if (WRAPPERS[p] && !w.dynamic) {
      k++;
      while (words[k] && words[k].text.startsWith('-')) { if (WRAPPERS[p].includes(words[k].text)) k++; k++; }
      while (p === 'env' && words[k] && /^[A-Za-z_]\w*=/.test(words[k].text)) k++;
      if (p === 'timeout' && words[k]) k++;
      continue;
    }
    break;
  }
  return words.slice(k);
}

// The code a shell runs with -c (bash), -Command (PowerShell) or /c (cmd).
function inlineShellCode(prog, args) {
  if (prog === 'cmd') {
    const at = args.findIndex((w) => /^\/[ck]$/i.test(w.text));
    return at < 0 ? null : args.slice(at + 1).map((w) => w.text).join(' ');
  }
  if (prog === 'pwsh' || prog === 'powershell') {
    const at = args.findIndex((w) => /^-(c|command)$/i.test(w.text));
    if (at >= 0) return args.slice(at + 1).map((w) => w.text).join(' ');
    if (args.some((w) => /^-(f|file|encodedcommand|e|ec)$/i.test(w.text))) return null;
    const first = args.findIndex((w) => !w.text.startsWith('-'));
    return first < 0 ? null : args.slice(first).map((w) => w.text).join(' ');
  }
  const at = args.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.text));
  return at >= 0 && args[at + 1] ? args[at + 1].text : null;
}

// PowerShell parameters: { named: { '-path': [word] }, positional: [word] }.
function psArgs(args) {
  const named = {};
  const positional = [];
  for (let k = 0; k < args.length; k++) {
    const w = args[k];
    const m = !w.dynamic && /^(-[A-Za-z][\w-]*)(?::(.*))?$/.exec(w.text);
    if (m) {
      const name = m[1].toLowerCase();
      if (m[2] !== undefined) { (named[name] ||= []).push({ ...w, text: m[2] }); continue; }
      if (PS_SWITCHES.has(name)) continue;
      if (args[k + 1]) { (named[name] ||= []).push(args[k + 1]); k++; }
      continue;
    }
    positional.push(w);
  }
  return { named, positional };
}
