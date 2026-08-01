'use strict';

// Splitting a shell line into the commands it will actually run is the part
// of this tool that has to be correct. A guard you can slip past by putting
// quotes in the right place is worse than no guard, because it reads as
// protection while providing none.
//
// This is deliberately NOT a bash parser. It is a conservative tokenizer
// with one job: find every place a new command can begin, without ever
// being fooled by a separator that sits inside a quoted string. When it
// meets something it does not understand, it fails loud rather than
// guessing, and the caller treats "unparseable" as high risk.

const SEPARATORS = [';', '&&', '||', '|', '&', '\n'];

/**
 * Split a command line into segments, respecting quoting and escapes.
 *
 * Returns { segments, substitutions, truncated }.
 *   segments      - the top-level commands, in order
 *   substitutions - text found inside $(...) or backticks, to be parsed
 *                   recursively by the caller; a dangerous command hidden
 *                   in a substitution still runs
 *   unbalanced    - true when quoting never closed, which means we cannot
 *                   trust our own split and the caller must escalate
 */
function splitCommands(line) {
  const segments = [];
  const substitutions = [];

  let current = '';
  let i = 0;
  let quote = null;          // "'" or '"' when inside a quoted run
  let unbalanced = false;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) segments.push(trimmed);
    current = '';
  };

  while (i < line.length) {
    const ch = line[i];

    // A backslash escapes the next character everywhere except inside
    // single quotes, where bash treats it literally.
    if (ch === '\\' && quote !== "'") {
      current += ch + (line[i + 1] || '');
      i += 2;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      // Command substitution is live inside double quotes. Inside single
      // quotes it is inert, so we only recurse for the double-quote case.
      else if (quote === '"' && ch === '$' && line[i + 1] === '(') {
        const end = matchParen(line, i + 1);
        if (end === -1) { unbalanced = true; break; }
        substitutions.push(line.slice(i + 2, end));
        current += line.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }

    // $(...) outside quotes.
    if (ch === '$' && line[i + 1] === '(') {
      const end = matchParen(line, i + 1);
      if (end === -1) { unbalanced = true; break; }
      substitutions.push(line.slice(i + 2, end));
      current += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // Legacy backtick substitution. Still valid, still runs commands.
    if (ch === '`') {
      const end = line.indexOf('`', i + 1);
      if (end === -1) { unbalanced = true; break; }
      substitutions.push(line.slice(i + 1, end));
      current += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    const sep = SEPARATORS.find((s) => line.startsWith(s, i));
    if (sep) {
      push();
      i += sep.length;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (quote) unbalanced = true;
  push();

  return { segments, substitutions, unbalanced };
}

/** Index of the ')' matching the '(' at `open`, or -1 if never closed. */
function matchParen(line, open) {
  let depth = 0;
  for (let i = open; i < line.length; i += 1) {
    if (line[i] === '\\') { i += 1; continue; }
    if (line[i] === '(') depth += 1;
    else if (line[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Break one command segment into argv, dropping leading environment
 * assignments (FOO=bar cmd) and common wrappers that would otherwise hide
 * the real command from classification.
 *
 * `sudo terraform destroy` must classify as terraform, not as sudo.
 */
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'nohup', 'nice', 'time', 'exec', 'env', 'xargs']);

// Wrapper flags that consume the NEXT argument. Without this, `sudo -u deploy
// systemctl stop nginx` unwraps to `deploy systemctl stop nginx` and the real
// command is never classified. That is a silent bypass, not a cosmetic bug.
const WRAPPER_VALUE_FLAGS = {
  sudo: new Set(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-T', '-D', '-R', '--user', '--group', '--prompt', '--host', '--role', '--type', '--chdir', '--chroot']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
  xargs: new Set(['-n', '-P', '-I', '-a', '-d', '-E', '-L', '-s', '--max-args', '--max-procs', '--replace', '--arg-file', '--delimiter', '--max-lines', '--max-chars']),
  time: new Set(['-o', '-f', '--output', '--format']),
};

function toArgv(segment) {
  const argv = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];

    if (ch === '\\' && quote !== "'") {
      current += segment[i + 1] || '';
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (current) { argv.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) argv.push(current);

  // Strip leading VAR=value assignments and wrapper commands. Both can be
  // stacked: `sudo -u deploy env FOO=1 terraform destroy`.
  let start = 0;
  while (start < argv.length) {
    const token = argv[start];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { start += 1; continue; }
    const name = basename(token);
    if (WRAPPERS.has(name)) {
      const valueFlags = WRAPPER_VALUE_FLAGS[name] || new Set();
      start += 1;
      // Skip the wrapper's own flags so we land on the wrapped command,
      // consuming the value of any flag that takes one.
      while (start < argv.length && argv[start].startsWith('-')) {
        const flag = argv[start];
        start += 1;
        // `--user=deploy` carries its value inline; `-u deploy` does not.
        if (valueFlags.has(flag) && !flag.includes('=')) start += 1;
      }
      continue;
    }
    break;
  }

  return argv.slice(start);
}

/** Command name without a path or .exe suffix, lowercased. */
function basename(token) {
  const tail = token.split(/[/\\]/).pop() || token;
  return tail.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/**
 * Full expansion of a command line into every argv that could run,
 * including those hidden inside command substitutions.
 */
function expand(line, depth = 0) {
  const { segments, substitutions, unbalanced } = splitCommands(line);
  const commands = segments.map((segment) => ({ raw: segment, argv: toArgv(segment) }));

  // Depth cap: a substitution nested this deep is either generated or
  // adversarial, and either way it is not something to quietly unwrap.
  if (depth < 4) {
    for (const sub of substitutions) {
      const nested = expand(sub, depth + 1);
      commands.push(...nested.commands);
      if (nested.unbalanced) return { commands, unbalanced: true };
    }
  }

  return { commands, unbalanced };
}

module.exports = { splitCommands, toArgv, basename, expand };
