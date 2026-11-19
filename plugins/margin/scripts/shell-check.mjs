// What a shell command would read, as far as can be told without running it.
// Loaded by shell-guard.mjs only while focus is on.
//
// classify(command, { dialect: 'bash' | 'powershell', cwd, scriptsDir }) returns
//   reads     files a known reader (cat, head, Get-Content, ...) would open
//   searches  folders a recursive search (grep -r, rg, find -exec, ...) would cover
//   named     existing paths that an interpreter one-liner or an unknown program names
//   unknown   reader operands that can't be worked out ($VAR, $(...), names from a pipe)
//   moves     files mv moves: { from, to } (into the list, they ask)
// Listing names (ls, find, Get-ChildItem), echo/printf text and Margin's own
// scripts read nothing. Each entry is { path | dir | word, program }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
const MAX_DEPTH = 3;
// Stands for the shell's current folder ($PWD) until the folder is known.
const PWD_MARK = '\u0001PWD\u0001';
// The start of a .NET static call in PowerShell: [IO.File]::ReadAllText(...)
const DOTNET = /^\[([^\]]+)\]::/;
// .NET types whose calls read a file named in their arguments.
const DOTNET_READERS = /^(system\.)?io\.(file|filestream|fileinfo|streamreader|binaryreader)$/i;
// A subshell or command substitution: a `cd` inside it doesn't outlast it.
const SCOPE_OPEN = { scope: 'open' };
const SCOPE_CLOSE = { scope: 'close' };

// PowerShell takes \ as well as / between folders on every system, but Node's path
// module only knows \ on Windows; elsewhere, PowerShell words get / instead.
export function psSeparators(text, platform = process.platform) {
  return platform === 'win32' ? text : text.replace(/\\/g, '/');
}

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
// Programs that pack or copy whole folders named by a bare word: `tar czf - notes`.
const ARCHIVERS = new Set(['tar', 'bsdtar', 'gtar', 'zip', '7z', '7za', '7zr', 'rar', 'ditto', 'rsync', 'scp', 'cpio', 'pax',
  'gzip', 'bzip2', 'xz', 'zstd', 'lz4', 'compress-archive']);
const SEARCH_BY_DEFAULT = new Set(['rg', 'ag', 'ack', 'ugrep']);
const LISTERS = new Set(['ls', 'dir', 'vdir', 'tree', 'find', 'gfind', 'fd', 'fdfind', 'get-childitem', 'gci', 'get-item', 'gi']);
// Programs that don't show file contents to Claude.
const QUIET = new Set([
  'echo', 'printf', 'true', 'false', 'test', '[', '[[', ':', 'pwd', 'stat', 'du', 'df', 'file', 'which', 'whereis',
  'realpath', 'readlink', 'basename', 'dirname', 'mkdir', 'rmdir', 'touch', 'rm', 'chmod', 'chown', 'chgrp',
  'open', 'xdg-open', 'start', 'code', 'explorer', 'sleep', 'date', 'clear', 'export', 'unset', 'alias', 'read', 'wait',
  'kill', 'ps', 'whoami', 'hostname', 'uname', 'history', 'exit', 'return', 'set', 'shopt', 'tee', 'tr', 'seq',
  'locate', 'trap', 'local', 'declare', 'readonly', 'type' /* bash builtin; PowerShell's type is a reader */,
  'write-output', 'write', 'write-host', 'out-host', 'out-null', 'out-string', 'out-file', 'set-content', 'sc',
  'add-content', 'ac', 'new-item', 'ni', 'md', 'remove-item', 'ri', 'del', 'erase', 'rd', 'move-item', 'mi', 'move',
  'rename-item', 'ren', 'rni', 'test-path', 'resolve-path', 'rvpa', 'split-path', 'join-path', 'get-location', 'gl',
  'select-object', 'select', 'where-object', 'where', '?', 'foreach-object', 'foreach', '%', 'sort-object',
  'measure-object', 'measure', 'format-table', 'ft', 'format-list', 'fl', 'get-date', 'start-sleep', 'invoke-item', 'ii',
  'start-process', 'saps', 'get-command', 'gcm', 'get-help', 'clear-host', 'cls', 'get-filehash', 'compare-object',
  'get-process', 'gps', 'get-service', 'get-variable', 'set-variable', 'new-object', 'add-type', 'out-default'
]);
// git subcommands that change or report state without printing a file's contents. The
// ones that can (diff, show, log, grep, blame, cat-file, ...) are not listed, so they
// still ask when they name a file outside the list.
const QUIET_GIT = new Set(['add', 'rm', 'mv', 'commit', 'restore', 'checkout', 'switch', 'reset', 'status', 'push', 'pull', 'fetch', 'tag', 'branch', 'init', 'clone', 'merge', 'rebase', 'clean']);
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
// git grep options whose value is the next word (-f, the pattern file, is read).
const GIT_GREP_VALUES = new Set(['-A', '-B', '-C', '-m', '--max-count', '--max-depth', '--threads', '--context', '--after-context', '--before-context']);
// git subcommands that print a file given as <rev>:<path> (git show HEAD:notes/x.md).
const GIT_REV_PATH = new Set(['show', 'cat-file', 'diff']);

// The path in git's <rev>:<path> form ("HEAD:notes/x.md", ":notes/x.md" for the
// staged copy, ":2:x.md"); null for anything else, including C:\ paths, URLs and
// user@host:path remotes.
function revPath(text) {
  if (!text || text.startsWith('-') || /^[A-Za-z]:[\\/]/.test(text) || /^[A-Za-z][\w+.-]*:\/\//.test(text)) return null;
  const m = /^(:[0-3]:|[^:]*:)([\s\S]*)$/.exec(text);
  if (!m || /^[\w.-]+@[\w.-]+:$/.test(m[1])) return null;
  return m[2];
}

const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const PUSH = new Set(['pushd', 'push-location']);
const POP = new Set(['popd', 'pop-location']);
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
// Options whose value is the next word (so it isn't taken for a file). Only real
// value options belong here: a switch listed by mistake would swallow the file name
// after it (column -t, od -w), and that file would never be checked.
const OPT_VALUES = {
  head: ['-n', '-c'], tail: ['-n', '-c'], sort: ['-k', '-t', '-T', '-S', '--key', '--field-separator'], cut: ['-d', '-f', '-c', '-b'],
  grep: ['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--context'],
  rg: ['-e', '-f', '-g', '-m', '-A', '-B', '-C', '-t', '-T', '-j', '-M', '--glob', '--type', '--type-not', '--max-count', '--regexp', '--file', '--threads', '--sort', '--sortr'],
  ag: ['-G', '-m', '-A', '-B', '-C', '--ignore', '--file-search-regex'], ack: ['--type', '-m'], ugrep: ['-e', '-f', '-m', '-A', '-B', '-C', '-g', '-t'],
  sed: ['-e', '-f', '-l', '--expression', '--file'], awk: ['-f', '-v', '-F', '--file', '--assign', '--field-separator'],
  diff: ['-U', '-C', '-x', '-X', '--exclude'], od: ['-t', '-N', '-j', '-A'] /* -w takes its value attached (-w16) */, xxd: ['-l', '-s', '-c', '-g', '-o'],
  hexdump: ['-n', '-s', '-e', '-f'], jq: ['--indent', '-f', '--from-file'], paste: ['-d'], base64: ['-w'], iconv: ['-f', '-t'],
  fold: ['-w'], fmt: ['-w'], join: ['-1', '-2', '-t', '-o'], split: ['-l', '-b', '-n'], nl: ['-b', '-w', '-s', '-v', '-i'],
  bat: ['-l', '-r', '-H', '--language', '--line-range', '--highlight-line', '--theme', '--style'], cmp: ['-n', '-i'],
  // column: -t (table) is a switch; these take a value (util-linux and BSD).
  column: ['-s', '-c', '-o', '-n', '-N', '-E', '-H', '-i', '-l', '-O', '-p', '-r', '-R', '-T', '-W'], strings: ['-n', '-t'], less: ['-p', '-x'], tac: ['-s'], cp: ['-t', '-S', '--target-directory', '--suffix']
};
for (const alias of ['egrep', 'fgrep', 'zgrep']) OPT_VALUES[alias] = OPT_VALUES.grep;
for (const alias of ['gawk', 'mawk', 'nawk']) OPT_VALUES[alias] = OPT_VALUES.awk;
const PS_SWITCHES = new Set(['-recurse', '-file', '-directory', '-force', '-name', '-hidden', '-readonly', '-system', '-followsymlink',
  '-raw', '-wait', '-asbytestream', '-simplematch', '-casesensitive', '-quiet', '-list', '-notmatch', '-allmatches', '-container', '-passthru']);
// The aliases PowerShell defines for those switches: Get-ChildItem's -s (-Recurse),
// -ad/-d (-Directory), -af (-File), -ah/-h (-Hidden), -ar (-ReadOnly), -as (-System).
const PS_SWITCH_ALIASES = new Set(['-s', '-ad', '-d', '-af', '-ah', '-h', '-ar', '-as']);
// PowerShell also takes the start of a parameter name: -r or -rec for -Recurse, -fo for -Force.
const isPsSwitch = (name) => PS_SWITCHES.has(name) || PS_SWITCH_ALIASES.has(name) ||
  ((name === '-r' || name.length > 2) && [...PS_SWITCHES].some((s) => s.startsWith(name)));
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

  function newCommand(pipedFrom) { return { words: [], inputs: [], heredocs: [], herestrings: [], pipedFrom, callOp: false }; }
  // quoted: part of the word was quoted or escaped. inner: the text of a PowerShell
  // ( ... ) argument, kept so a .NET call's arguments can be looked at.
  function startWord() { if (!word) word = { text: '', dynamic: false, glob: false, onlyVar: null, quoted: false }; }
  function endWord() {
    if (!word) return;
    const w = word;
    word = null;
    if (ps) w.text = psSeparators(w.text);
    if (pending) {
      const r = pending;
      pending = null;
      if (r === 'in') cmd.inputs.push(w);
      // An unquoted delimiter (<<EOF) means bash expands $( ) in the body.
      else if (r === 'here') heredocs.push({ delim: w.text, strip: heredocStrip, cmd, expand: !w.quoted });
      else if (r === 'herestring') cmd.herestrings.push(w); // the command's input: code, if it's a shell
      return; // output targets and fd numbers aren't reads
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
  // Commands inside $( ), backticks or <( ). In bash they run in a subshell, so a
  // `cd` there doesn't outlast them; in PowerShell a location change does.
  function nested(text) {
    if (depth >= MAX_DEPTH) return;
    const inner = tokenize(text, dialect, vars, depth + 1);
    if (ps) commands.push(...inner);
    else commands.push(SCOPE_OPEN, ...inner, SCOPE_CLOSE);
  }
  function substitute(name) {
    const key = ps ? name.toLowerCase() : name;
    const wasEmpty = !word.text && !word.dynamic;
    if (key === 'HOME' || key === 'home' || key === 'env:home' || key === 'env:userprofile') { word.text += os.homedir(); return; }
    if (key === 'PWD' || key === 'pwd') { word.text += PWD_MARK; return; }
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
      const body = lines.join('\n');
      h.cmd.heredocs.push(body);
      if (h.expand) for (const code of substitutionsIn(body)) nested(code);
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
        word.quoted = true;
        word.text += src.slice(bodyStart, stop).replace(/\r$/, '');
        if (q === '"' && word.text.includes('$')) word.dynamic = true;
        i = e < 0 ? n : e + 3;
        continue;
      }
      if (c === "'") {
        startWord();
        word.quoted = true;
        let j = i + 1;
        while (j < n) { if (src[j] === "'") { if (src[j + 1] === "'") { word.text += "'"; j += 2; continue; } break; } word.text += src[j]; j++; }
        i = j + 1;
        continue;
      }
      if (c === '"') {
        startWord();
        word.quoted = true;
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
        if (!word && !cmd.words.length) { cmd.callOp = true; i++; continue; } // the call operator: & "C:\tool.exe" args
        endCommand(false); i++; continue;
      }
      if (c === '(' && (word || cmd.words.length)) { // (subexpression) as an argument: its value is only known when it runs
        endWord(); startWord(); const end = findClose(i, '(', ')'); word.inner = psSeparators(src.slice(i + 1, end)); nested(word.inner); word.dynamic = true; i = end + 1; continue;
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
      if (c === '\\') { if (src[i + 1] === '\n') { i += 2; continue; } startWord(); word.quoted = true; word.text += src[i + 1] ?? ''; i += 2; continue; }
      if (c === "'") { startWord(); word.quoted = true; const e = src.indexOf("'", i + 1); const stop = e < 0 ? n : e; word.text += src.slice(i + 1, stop); i = stop + 1; continue; }
      if (c === '"') {
        startWord();
        word.quoted = true;
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
      if (c === '$') { startWord(); if (src[i + 1] === "'") { word.quoted = true; const e = src.indexOf("'", i + 2); const stop = e < 0 ? n : e; word.text += src.slice(i + 2, stop); i = stop + 1; } else i = readDollar(i); continue; }
      if (c === '`') { startWord(); i = readBacktickCommand(i); continue; }
      if (c === '|') { if (src[i + 1] === '|') { endCommand(false); i += 2; } else { endCommand(true); i += src[i + 1] === '&' ? 2 : 1; } continue; }
      if (c === '&') {
        if (src[i + 1] === '&') { endCommand(false); i += 2; continue; }
        if (src[i + 1] === '>') { endWord(); pending = 'out'; i += src[i + 2] === '>' ? 3 : 2; continue; }
        endCommand(false); i++; continue;
      }
      if (c === ';') { endCommand(false); i += src[i + 1] === ';' ? 2 : 1; continue; }
      if (c === '(' && !word) { endCommand(false); commands.push(SCOPE_OPEN); i++; continue; }   // ( subshell )
      if (c === ')') { endCommand(false); commands.push(SCOPE_CLOSE); i++; continue; }
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
      // ~+ is the current folder; ~- (the previous folder) and ~name (another user's
      // home) are only known when the shell runs.
      if (c === '~' && !word && /[+-]/.test(src[i + 1] || '') && (i + 2 >= n || /[\s/;|&)]/.test(src[i + 2]))) {
        startWord(); if (src[i + 1] === '+') word.text += PWD_MARK; else word.dynamic = true; i += 2; continue;
      }
      if (c === '~' && !word && /[A-Za-z_]/.test(src[i + 1] || '')) {
        let j = i + 1;
        while (j < n && /[\w.-]/.test(src[j])) j++;
        if (j >= n || /[\s/;|&)]/.test(src[j])) { startWord(); word.dynamic = true; i = j; continue; }
      }
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
  if (t.includes(PWD_MARK)) { if (!cwd) return null; t = t.split(PWD_MARK).join(cwd); }
  if (IS_WINDOWS) { const m = /^\/([a-zA-Z])(?:\/|$)(.*)$/.exec(t); if (m) t = `${m[1]}:/${m[2]}`; } // Git Bash: /c/Users/... is C:/Users/...
  if (t === '~' || t.startsWith('~/') || t.startsWith('~\\')) t = path.join(os.homedir(), t.slice(1));
  if (path.isAbsolute(t)) return path.resolve(t);
  return cwd ? path.resolve(cwd, t) : null;
}

// Special device files hold none of the writer's text: `< /dev/null`, `diff x /dev/null`.
// Judged by the name as typed, so it holds on every OS whether or not the file exists.
const DEVICE = /^\/dev\/(?:null|zero|full|stdin|stdout|stderr|tty|random|urandom|fd\/\d+)$/;

const statOf = (p) => { try { return fs.statSync(p); } catch { return null; } };

// The path in a file:// URL: file:///Users/me/x.md -> /Users/me/x.md, file:///C:/x -> C:/x.
function fileUrlPath(url) {
  let p = url.replace(/^file:\/\/(localhost)?/i, '');
  try { p = decodeURIComponent(p); } catch { /* keep it as written */ }
  return /^\/[A-Za-z]:[\\/]/.test(p) ? p.slice(1) : p;
}

// The folder part of a wildcard path ("notes/*.md" -> "notes", "*/x.md" -> ".").
function globFolder(text) {
  const parts = text.split(/[\\/]/);
  const fixed = [];
  for (const part of parts) { if (/[*?[{]/.test(part)) break; fixed.push(part); }
  return fixed.length ? fixed.join('/') || '/' : '.';
}

export function classify(command, { dialect = 'bash', cwd = null, scriptsDir = null, root = null } = {}) {
  const out = { reads: [], searches: [], named: [], unknown: [], moves: [] };
  const scriptsReal = scriptsDir ? safeReal(scriptsDir) : null;
  // Names that mv, cp or ln give things earlier in this command line: a later read
  // through the new name is judged by where the file really is, since the check
  // runs before any of it exists (ln -s ../notes drafts/x; cat drafts/x/a.md).
  const aliases = [];
  run(command, dialect, cwd, 0);
  return out;

  function safeReal(p) { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }
  function viaAlias(p) {
    const key = (s) => (IS_WINDOWS || process.platform === 'darwin' ? s.toLowerCase() : s);
    for (let i = aliases.length - 1; i >= 0; i--) {
      const { at, to } = aliases[i];
      if (key(p) === key(at) || key(p).startsWith(key(at) + path.sep)) return to + p.slice(at.length);
    }
    return p;
  }

  // Runs a command line, following its current folder: `cd`, `pushd`/`popd` (null
  // when it can't be known), and subshells, after which the folder is as before.
  // Returns the folder at the end.
  function run(text, dl, startCwd, depth) {
    let here = startCwd;
    const ctx = { dirs: [] };
    const scopes = [];
    for (const c of tokenize(text, dl, {}, 0)) {
      if (c === SCOPE_OPEN) { scopes.push({ here, dirs: [...ctx.dirs] }); continue; }
      if (c === SCOPE_CLOSE) { const s = scopes.pop(); if (s) { here = s.here; ctx.dirs = s.dirs; } continue; }
      const next = one(c, dl, here, depth, ctx);
      if (next !== undefined) here = next;
    }
    return here;
  }

  // Code a shell runs in the current session (eval, Invoke-Expression): parsed like
  // the rest; code that is only known when it runs can't be checked, so it asks.
  function inlineRun(words, dl, cwd, depth, program, c) {
    if (!words.length) { if (c.pipedFrom) out.unknown.push({ word: 'code from its input', program }); return undefined; }
    if (words.some((w) => w.dynamic) || depth >= MAX_DEPTH) { out.unknown.push({ word: words.map((w) => w.text).join(' ') || '(a variable)', program }); return undefined; }
    return run(words.map((w) => w.text).join(' '), dl, cwd, depth + 1);
  }

  // PowerShell .NET calls such as [IO.File]::ReadAllText('notes\x.md'): string
  // literals in the arguments that name existing files outside the list ask; for
  // the file-reading types, an argument only known when it runs asks too.
  function dotnetCalls(words, cwd) {
    for (let k = 0; k < words.length; k++) {
      const m = DOTNET.exec(words[k].text);
      const call = words[k + 1];
      if (!m || !call || call.inner === undefined) continue;
      scanCode(call.inner, cwd, words[k].text);
      const rest = call.inner.replace(/\$(\{pwd\}|pwd)(?!\w)/gi, '');
      if (DOTNET_READERS.test(m[1]) && /[$(]/.test(rest)) out.unknown.push({ word: call.inner.trim(), program: words[k].text });
    }
  }

  // A word a reader would open: a file, a folder searched recursively, or a wildcard.
  function readTarget(w, cwd, program, recursive) {
    if (w.dynamic) { out.unknown.push({ word: w.text || '(a variable)', program }); return; }
    if (DEVICE.test(w.text)) return;
    if (w.glob) {
      const found = resolvePath(globFolder(w.text), cwd);
      if (found === null) { out.unknown.push({ word: w.text, program }); return; }
      const dir = viaAlias(found);
      if (statOf(dir)) out.searches.push({ dir, program });
      return;
    }
    const found = resolvePath(w.text, cwd);
    if (found === null) { out.unknown.push({ word: w.text, program }); return; }
    const p = viaAlias(found);
    const st = statOf(p);
    if (!st) return;
    if (st.isDirectory()) { if (recursive) out.searches.push({ dir: p, program }); return; }
    out.reads.push({ path: p, program });
  }

  // Existing paths an interpreter or unknown program names: the writer is asked.
  // Only words that look like paths count, so "npm test" or "make docs" don't
  // prompt just because a folder of that name exists. `bare`: the word is known to
  // be a name even without a / or an extension (after `--`, or for an archiver).
  // `operand`: it comes after `--`, so a leading - is part of the name.
  function named(w, cwd, program, { bare = false, operand = false } = {}) {
    if (w.dynamic || !w.text || DEVICE.test(w.text)) return;
    let text = w.text;
    if (!operand && /^-/.test(text)) { const eq = text.indexOf('='); if (eq < 0) return; text = text.slice(eq + 1); }
    if (/^file:\/\//i.test(text)) text = fileUrlPath(text); // curl file:///Users/me/notes/x.md
    if (/^\.\.?$/.test(text)) return; // a bare "." or ".." is the current folder: "git add .", "pip install ."
    if (!bare && !/[\\/]/.test(text) && !/\.[A-Za-z0-9]{1,8}$/.test(text)) return;
    const found = resolvePath(w.glob ? globFolder(text) : text, cwd);
    const p = found === null ? null : viaAlias(found);
    if (p !== null && statOf(p)) out.named.push({ path: p, program });
  }

  // String literals in inline code that name existing files. A leading $PWD is the
  // current folder.
  function scanCode(code, cwd, program) {
    let count = 0;
    for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      if (++count > 64) break;
      const text = m[2].replace(/\\\\/g, '\\').trim().replace(/^\$(\{pwd\}|pwd)(?=[\\/]|$)/i, PWD_MARK);
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

  function one(c, dl, cwd, depth, ctx) {
    const ps = dl === 'powershell';
    for (const w of c.inputs) readTarget(w, cwd, '<', false);
    let words = stripPrefix(c.words);
    if (!words.length) return undefined;
    if (LOOP_HEADERS.has(words[0].text)) return undefined;
    if (ps) dotnetCalls(words, cwd);
    const progWord = words[0];
    const args = words.slice(1);
    if (progWord.dynamic) { for (const w of args) named(w, cwd, progWord.text || 'a program'); return undefined; }
    // In PowerShell a line that starts with a string (and no & call operator) is an
    // expression, not a command: its strings may name files, e.g. the argument of a
    // .NET call, so they are checked like an interpreter's.
    if (ps && progWord.quoted && !c.callOp) { for (const w of words) named(w, cwd, 'PowerShell'); return undefined; }
    const prog = programName(progWord.text);

    if (POP.has(prog)) return ctx.dirs.length ? ctx.dirs.pop() : null;
    if (CD.has(prog)) {
      const target = ps ? (psArgs(args).named['-path']?.[0] || psArgs(args).positional[0]) : args.find((w) => !/^-/.test(w.text) || w.text === '-');
      if (PUSH.has(prog)) ctx.dirs.push(cwd);
      if (!target) return PUSH.has(prog) ? (ps ? undefined : null) : ps ? undefined : os.homedir();
      if (target.dynamic || target.text === '-') return null;
      return resolvePath(target.text, cwd);
    }
    if (prog === 'node' && isMarginScript(args, cwd)) return undefined;
    if (!ps && prog === 'eval') return inlineRun(args, dl, cwd, depth, 'eval', c);
    if (ps && (prog === 'invoke-expression' || prog === 'iex')) {
      const a = psArgs(args);
      return inlineRun([...(a.named['-command'] || []), ...a.positional], dl, cwd, depth, prog, c);
    }

    if (SHELLS[prog]) {
      const code = inlineShellCode(prog, args);
      const inner = SHELLS[prog];
      const runCode = (text) => { if (depth < MAX_DEPTH) run(text, inner, cwd, depth + 1); else out.unknown.push({ word: text, program: prog }); };
      if (code !== null && code !== '-') { runCode(code); return undefined; }
      for (const h of c.heredocs) runCode(h);
      // With no -c and no script file (or with -s, or -Command -), a shell runs the
      // code on its input: a here-string, or what the command before it prints.
      if (code === '-' || readsCodeFromInput(prog, args)) {
        for (const s of c.herestrings || []) { if (s.dynamic) out.unknown.push({ word: s.text || '(a variable)', program: prog }); else runCode(s.text); }
        if (c.pipedFrom) {
          const text = literalOutput(c.pipedFrom, dl);
          if (text === null) out.unknown.push({ word: 'code from its input', program: prog }); else runCode(text);
        }
      }
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
    if (prog === 'fd' || prog === 'fdfind') {   // fd -x cmd runs cmd on every file it finds
      const at = args.findIndex((w) => /^(-x|-X|--exec|--exec-batch)$/.test(w.text) || /^--exec(-batch)?=/.test(w.text));
      if (at >= 0) for (const r of fdRoots(args.slice(0, at))) readTarget(r, cwd, `${prog} -x`, true);
      return undefined;
    }
    // Moving or linking gives a file a new name: reads through it later in the line
    // are judged by the real file, and a move from outside the list into it asks.
    if (!ps && (prog === 'mv' || prog === 'ln')) { moveOrLink(prog, args, cwd); return undefined; }
    if (ps && (prog === 'move-item' || prog === 'mi' || prog === 'move')) {
      const a = psArgs(args);
      const sources = [...(a.named['-path'] || []), ...(a.named['-literalpath'] || [])];
      const rest = [...a.positional];
      if (!sources.length && rest.length) sources.push(rest.shift());
      const dest = (a.named['-destination'] || [])[0] || rest[0];
      if (dest) relocate('mv', sources, dest, cwd);
      return undefined;
    }
    if (ps && (prog === 'new-item' || prog === 'ni')) {
      const a = psArgs(args);
      const type = (a.named['-itemtype'] || a.named['-type'] || [])[0];
      const target = (a.named['-target'] || a.named['-value'] || [])[0];
      const at = (a.named['-path'] || [])[0] || a.positional[0];
      if (type && /^(symboliclink|junction|hardlink)$/i.test(type.text) && target && at && !target.dynamic && !at.dynamic) {
        const atAbs = resolvePath(at.text, cwd);
        const toAbs = resolvePath(target.text, cwd);
        if (atAbs && toAbs) aliases.push({ at: atAbs, to: viaAlias(toAbs) });
      }
      return undefined;
    }
    if (LISTERS.has(prog) || (QUIET.has(prog) && !(ps && PS_READERS.has(prog)))) return undefined;

    if (prog === 'git') { gitCommand(args, cwd); return undefined; }

    const readers = ps ? PS_READERS : POSIX_READERS;
    if (!readers.has(prog)) { otherProgram(prog, args, cwd); return undefined; }

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
      const copy = ['copy-item', 'copy', 'cp', 'cpi'].includes(prog);
      paths.push(...(copy ? a.positional.slice(0, 1) : a.positional));
      if (!paths.length) pipedSearch(c, cwd, prog, true, dl);
      // Copy-Item -Recurse copies a whole folder, so it reads everything in it.
      const recurse = copy && args.some((w) => !w.dynamic && w.text.length > 1 && '-recurse'.startsWith(w.text.toLowerCase()));
      for (const w of paths) readTarget(w, cwd, prog, recurse);
      const dest = copy ? ((a.named['-destination'] || [])[0] || a.positional[1]) : null;
      if (dest) relocate('cp', paths, dest, cwd);
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
    if (['awk', 'gawk', 'mawk', 'nawk'].includes(prog)) {
      for (const w of [...(named_.get('-f') || []), ...(named_.get('--file') || [])]) readTarget(w, cwd, prog, false);
      if (!has('-f', '--file')) {
        if (operands[0]) scanCode(operands[0].text, cwd, prog);   // the program can open files itself (getline < "x")
        files = operands.slice(1);
      }
    }
    if (prog === 'cp' && !has('-t', '--target-directory')) files = operands.slice(0, -1);
    // cp -r / -a copies a whole folder, so it reads everything in it.
    const copiesFolders = prog === 'cp' && ([...named_.keys()].some((f) => !f.startsWith('--') && /^-[a-zA-Z]*[rRa][a-zA-Z]*$/.test(f)) || has('--recursive', '--archive'));
    for (const w of files) readTarget(w, cwd, prog, copiesFolders);
    if (prog === 'cp') {
      const into = [...(named_.get('-t') || []), ...(named_.get('--target-directory') || [])][0];
      if (into) relocate('cp', files, into, cwd, { intoFolder: true });
      else if (operands.length > 1) relocate('cp', files, operands[operands.length - 1], cwd);
    }
    return undefined;
  }

  // mv, cp and ln: every operand but the last is a source (all of them with -t DIR;
  // a lone `ln -s target` links into the current folder).
  function moveOrLink(prog, args, cwd) {
    const operands = [];
    let targetDir = null;
    let symbolic = false;
    let afterDashes = false;
    for (let k = 0; k < args.length; k++) {
      const w = args[k];
      if (!afterDashes && !w.dynamic && w.text === '--') { afterDashes = true; continue; }
      if (!afterDashes && !w.dynamic && w.text.length > 1 && w.text.startsWith('-')) {
        if (w.text === '-t' || w.text === '--target-directory') { targetDir = args[k + 1] || null; k++; continue; }
        if (w.text.startsWith('--target-directory=')) { targetDir = { ...w, text: w.text.slice('--target-directory='.length) }; continue; }
        if (w.text === '-S' || w.text === '--suffix') { k++; continue; }
        if (prog === 'ln' && (w.text === '--symbolic' || /^-[a-zA-Z]*s[a-zA-Z]*$/.test(w.text))) symbolic = true;
        continue;
      }
      operands.push(w);
    }
    if (targetDir) { relocate(prog, operands, targetDir, cwd, { symbolic, intoFolder: true }); return; }
    if (operands.length > 1) relocate(prog, operands.slice(0, -1), operands[operands.length - 1], cwd, { symbolic });
    else if (prog === 'ln' && operands.length === 1) relocate(prog, operands, null, cwd, { symbolic, intoFolder: true });
  }

  // Records the new name each source gets (`dest` is a folder they go into, or the
  // new name of a single source; null means the current folder). A symlink's
  // relative target counts from the folder the link is made in. A move from outside
  // the list into it is noted, since afterwards the file reads as part of the list.
  function relocate(prog, sources, dest, cwd, { symbolic = false, intoFolder = false } = {}) {
    const destAbs = dest === null ? cwd : dest.dynamic ? null : resolvePath(dest.text, cwd);
    const st = destAbs ? statOf(viaAlias(destAbs)) : null;
    const isFolder = intoFolder || sources.length > 1 || (dest !== null && /[\\/]$/.test(dest.text)) || !!(st && st.isDirectory());
    const linkDir = destAbs ? (isFolder ? destAbs : path.dirname(destAbs)) : null;
    for (const s of sources) {
      if (s.dynamic) continue;
      const fromAbs = symbolic && !path.isAbsolute(s.text) ? (linkDir ? path.resolve(linkDir, s.text) : null) : resolvePath(s.text, cwd);
      if (!fromAbs) continue;
      const from = viaAlias(fromAbs);
      const to = destAbs ? (isFolder ? path.join(destAbs, path.basename(fromAbs)) : destAbs) : null;
      if (to) aliases.push({ at: to, to: from });
      if (prog === 'mv' && statOf(from)) out.moves.push({ from, to, program: prog });
    }
  }

  // git: subcommands that print no file contents pass. `git grep` is a search of
  // its paths, else of the folder it runs in (-C moves it). The rest ask when they
  // name a file outside the list, as other programs do.
  function gitCommand(args, cwd) {
    let here = cwd;
    let k = 0;
    for (; k < args.length; k++) {
      const w = args[k];
      if (w.dynamic) { otherProgram('git', args, cwd); return; }   // can't tell which subcommand
      if (w.text === '-C' && args[k + 1]) { here = args[k + 1].dynamic ? null : resolvePath(args[k + 1].text, here); k++; continue; }
      if (GIT_OPTIONS_WITH_VALUE.has(w.text)) { k++; continue; }
      if (w.text.startsWith('-')) continue;
      break;
    }
    const sub = args[k] ? args[k].text : null;
    if (!sub || QUIET_GIT.has(sub)) return;
    if (here === null) { out.unknown.push({ word: 'a folder only known when it runs (-C)', program: `git ${sub}` }); return; }
    // git matches wildcards in pathspecs itself, so a quoted "*.md" after `--` is one too.
    let dashes = false;
    const rest = args.slice(k + 1).map((w) => {
      if (!dashes) { if (w.text === '--' && !w.dynamic) dashes = true; return w; }
      return /[*?[]/.test(w.text) ? { ...w, glob: true } : w;
    });
    if (sub === 'grep') { gitGrep(rest, here); return; }
    const plain = [];
    let pathspecs = false;
    for (const w of rest) {
      if (!pathspecs && w.text === '--' && !w.dynamic) pathspecs = true;
      const p = GIT_REV_PATH.has(sub) && !pathspecs && !w.dynamic ? revPath(w.text) : null;
      if (p === null) plain.push(w); else revPathRead(p, here, `git ${sub}`);
    }
    otherProgram(`git ${sub}`, plain, here);
  }

  // <rev>:<path> prints that file as it was: a file outside the list is denied like
  // cat; one that is gone from the folder now is judged by where it was; a folder
  // only lists names. The path is from the top of the repository, unless it starts
  // with ./ or ../ (then from the current folder), as git reads it.
  function revPathRead(p, here, program) {
    if (!p) return;                                   // HEAD: lists the top folder
    const base = /^\.\.?([\\/]|$)/.test(p) ? here : gitTop(here);
    const abs = resolvePath(p, base);
    if (abs === null) { out.unknown.push({ word: p, program }); return; }
    const st = statOf(abs);
    if (st && st.isDirectory()) return;
    if (st) out.reads.push({ path: abs, program });
    else out.named.push({ path: abs, program });
  }

  // The top of the git repository holding `from` (the nearest folder with .git),
  // else the project folder.
  function gitTop(from) {
    if (!from) return root;
    for (let d = from; ; d = path.dirname(d)) {
      if (statOf(path.join(d, '.git'))) return d;
      if (path.dirname(d) === d) return root || from;
    }
  }

  function gitGrep(args, here) {
    let patternGiven = false;
    const operands = [];
    const roots = [];
    let afterDashes = false;
    for (let j = 0; j < args.length; j++) {
      const w = args[j];
      if (afterDashes) { roots.push(w); continue; }
      if (w.text === '--' && !w.dynamic) { afterDashes = true; continue; }
      if (!w.dynamic && w.text.length > 1 && w.text.startsWith('-')) {
        if (w.text === '-e') { patternGiven = true; j++; continue; }
        if (w.text === '-f') { patternGiven = true; if (args[j + 1]) readTarget(args[j + 1], here, 'git grep -f', false); j++; continue; }
        if (GIT_GREP_VALUES.has(w.text)) j++;
        continue;
      }
      operands.push(w);
    }
    // Before `--`, a word that names an existing path is a path; anything else is a
    // revision (git grep x HEAD searches the files as they are at HEAD, from here down).
    for (const w of patternGiven ? operands : operands.slice(1)) {
      if (w.dynamic) { roots.push(w); continue; }
      if (/[*?[]/.test(w.text)) { roots.push({ ...w, glob: true }); continue; }   // a wildcard is a pathspec, not a revision
      const p = resolvePath(w.text, here);
      if (p !== null && statOf(p)) roots.push(w);
    }
    if (!roots.length) roots.push({ text: '.', dynamic: false, glob: false });
    for (const r of roots) {
      if (!r.dynamic && r.text.startsWith(':')) { out.unknown.push({ word: r.text, program: 'git grep' }); continue; } // :/ and other pathspec magic
      readTarget(r, here, 'git grep', true);
    }
  }

  // A program Margin doesn't know: an existing path it names outside the list asks.
  // After `--` every word is a name, and archivers take bare folder names, so those
  // count even without a / or an extension: `git show HEAD -- notes`, `tar czf - notes`.
  // Quoted strings inside an argument (SQL, a small script) are looked at too, as
  // for an interpreter's one-liner: sqlite3 :memory: "select readfile('notes/x.md')".
  function otherProgram(prog, args, cwd) {
    const archiver = ARCHIVERS.has(prog);
    let afterDashes = false;
    for (const w of args) {
      if (!afterDashes && w.text === '--' && !w.dynamic) { afterDashes = true; continue; }
      named(w, cwd, prog, { bare: archiver || afterDashes, operand: afterDashes });
      if (!w.dynamic && /['"]/.test(w.text)) scanCode(w.text, cwd, prog);
    }
  }

  // xargs runs a command on names it reads from its input, or from the file -a names
  // (whose contents end up on the command line, so that file counts as read).
  function xargs(c, args, dl, cwd, depth) {
    const withValue = ['-n', '-L', '-P', '-I', '-d', '-E', '-s', '-a', '--max-args', '--delimiter', '--arg-file'];
    let k = 0;
    while (k < args.length && args[k].text.startsWith('-')) {
      const t = args[k].text;
      if ((t === '-a' || t === '--arg-file') && args[k + 1]) readTarget(args[k + 1], cwd, 'xargs -a', false);
      else if (t.startsWith('--arg-file=')) readTarget({ ...args[k], text: t.slice('--arg-file='.length) }, cwd, 'xargs -a', false);
      if (withValue.includes(t)) k++;
      k++;
    }
    const inner = args.slice(k);
    if (!inner.length) return;
    const innerProg = programName(inner[0].text);
    one({ words: inner, inputs: [], heredocs: [], pipedFrom: null }, dl, cwd, depth, { dirs: [] });
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
  const found = classify(command, { dialect, cwd, scriptsDir, root });
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
  for (const m of found.moves) {
    if (rules.reasonFor(m.from) && (m.to === null || !rules.reasonFor(m.to))) {
      return { decision: 'ask', reason: `Margin focus is on, and this command (${m.program}) moves ${show(m.from)}, which isn't in the focus list (${rules.list}), into ${m.to ? show(m.to) : 'a folder Margin can’t tell'}, where Claude could then read it. Allow it only if that's fine.` };
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

// Whether a shell started without -c runs the code on its input: bash and friends
// do when given no script file, or -s; PowerShell and cmd when given no command or
// file (inlineShellCode returns '-' for pwsh -Command -).
const SHELL_OPTS_WITH_VALUE = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
function readsCodeFromInput(prog, args) {
  if (prog === 'cmd') return !args.some((w) => /^\/[ck]$/i.test(w.text));
  if (prog === 'pwsh' || prog === 'powershell') return !args.some((w) => /^-(f|file|c|command|encodedcommand|e|ec)$/i.test(w.text)) && args.every((w) => w.text.startsWith('-'));
  let operands = 0;
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(t)) return true;
    if (SHELL_OPTS_WITH_VALUE.has(t)) { k++; continue; }
    if (/^[-+]/.test(t)) continue;
    operands++;
  }
  return operands === 0;
}

const unescapeEcho = (t) => t.replace(/\\(n|t|\\)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : '\\'));

// What a command prints when it is all literal text: echo/printf/Write-Output with
// fixed words, cat with a here-document, or a PowerShell string on its own. null
// when it can't be known (a file, a variable, a download).
function literalOutput(src, dl) {
  const words = stripPrefix(src.words);
  if (!words.length || words[0].dynamic) return null;
  const rest = words.slice(1);
  if (rest.some((w) => w.dynamic)) return null;
  if (dl === 'powershell' && words.length === 1 && words[0].quoted && !src.callOp) return words[0].text;
  const p = programName(words[0].text);
  if (p === 'echo' || p === 'write-output' || p === 'write') {
    let k = 0;
    let escapes = false;
    if (dl !== 'powershell') while (rest[k] && /^-[neE]+$/.test(rest[k].text)) { if (rest[k].text.includes('e')) escapes = true; k++; }
    const text = rest.slice(k).map((w) => w.text).join(' ');
    return escapes ? unescapeEcho(text) : text;
  }
  if (p === 'printf') return rest.length ? unescapeEcho(rest.map((w) => w.text).join(' ')) : null;
  if (p === 'cat' && !rest.length) {
    const parts = [...src.heredocs, ...(src.herestrings || []).map((w) => w.text)];
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}

// The commands inside $( ... ) and backticks in a stretch of text: bash expands them
// in the body of a here-document whose delimiter isn't quoted.
function substitutionsIn(text) {
  const out = [];
  for (let j = 0; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') { j++; continue; }
    if (c === '$' && text[j + 1] === '(' && text[j + 2] !== '(') {
      let level = 0;
      let k = j + 1;
      for (; k < text.length; k++) {
        if (text[k] === '\\') { k++; continue; }
        if (text[k] === '(') level++;
        else if (text[k] === ')' && --level === 0) break;
      }
      out.push(text.slice(j + 2, k));
      j = k;
    } else if (c === '`') {
      let k = j + 1;
      while (k < text.length && text[k] !== '`') { if (text[k] === '\\') k++; k++; }
      out.push(text.slice(j + 1, k));
      j = k;
    }
  }
  return out;
}

// The folders `fd [pattern] [path...]` searches: its paths after the pattern (and any
// --search-path), else the current folder.
const FD_VALUES = new Set(['-e', '--extension', '-t', '--type', '-E', '--exclude', '-d', '--max-depth', '--min-depth', '--exact-depth',
  '-S', '--size', '-j', '--threads', '-c', '--color', '--changed-within', '--changed-before', '--change-newer-than', '--change-older-than',
  '-o', '--owner', '--ignore-file', '--path-separator', '--max-results', '--format', '--base-directory']);
function fdRoots(words) {
  const positional = [];
  const roots = [];
  for (let k = 0; k < words.length; k++) {
    const t = words[k].text;
    if (t === '--search-path' && words[k + 1]) { roots.push(words[++k]); continue; }
    if (t.startsWith('--search-path=')) { roots.push({ ...words[k], text: t.slice('--search-path='.length) }); continue; }
    if (t.startsWith('-') && !words[k].dynamic) { if (FD_VALUES.has(t)) k++; continue; }
    positional.push(words[k]);
  }
  roots.push(...positional.slice(1));
  return roots.length ? roots : [{ text: '.', dynamic: false, glob: false }];
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
      if (isPsSwitch(name)) continue;
      if (args[k + 1]) { (named[name] ||= []).push(args[k + 1]); k++; }
      continue;
    }
    positional.push(w);
  }
  return { named, positional };
}
