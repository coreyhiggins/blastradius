'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Opaque wrappers are the largest real hole in string-level classification.
// An audit of 166 commands found that the two used to ship a project to
// production were `npm run deploy` and `./deploy.sh push <jar> both`. Both
// sailed past every rule, because the risk lives inside a file rather than in
// the command line.
//
// This module resolves those to their contents so the classifier can see what
// will actually run.
//
// SAFETY, since this reads files chosen by an untrusted command string:
//   1. Reads only. Nothing here executes anything, ever.
//   2. The resolved path must stay inside the project directory. A command
//      naming ../../../etc/shadow gets no read.
//   3. Size and depth caps, so a huge or self-referential script cannot hang
//      the guard that runs before every command.
//   4. Every failure is silent and non-fatal. If we cannot read it, the
//      caller treats it as an unknown wrapper, which is still better than
//      crashing a hook that sits in front of the user's shell.

const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 2;

const SCRIPT_EXT = new Set(['.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1']);
const RUNNERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'source', '.', 'powershell', 'pwsh', 'cmd']);

/** True when `p` resolves inside `root`. Guards against ../ traversal. */
function insideProject(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Read a file if it is small enough and inside the project. Never throws. */
function readSafely(root, filePath) {
  try {
    const resolved = path.resolve(root, filePath);
    if (!insideProject(root, resolved)) return null;

    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;

    return fs.readFileSync(resolved, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Which file, if any, does this argv invoke as a script?
 *
 * Handles `./deploy.sh`, `bash scripts/release.sh`, and `pwsh ./build.ps1`.
 * Returns a project-relative path, or null.
 */
function scriptTarget(argv) {
  if (!argv.length) return null;

  const first = argv[0];
  const firstName = path.basename(first).toLowerCase();

  // `bash something.sh`
  if (RUNNERS.has(firstName)) {
    const target = argv.slice(1).find((a) => !a.startsWith('-'));
    if (target && SCRIPT_EXT.has(path.extname(target).toLowerCase())) return target;
    return null;
  }

  // `./deploy.sh` or `scripts/release.sh`
  if (SCRIPT_EXT.has(path.extname(first).toLowerCase())) return first;

  return null;
}

/**
 * `npm run deploy` and friends. Returns the script body from package.json,
 * or null.
 *
 * Package-manager run scripts are the most common wrapper of all, and they
 * are the one case where the command's real content is sitting in a file we
 * can parse rather than a shell script we have to guess at.
 */
function packageScript(root, argv) {
  if (!argv.length) return null;

  const tool = path.basename(argv[0]).toLowerCase();
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(tool)) return null;

  const rest = argv.slice(1).filter((a) => !a.startsWith('-'));
  // npm/pnpm/bun require an explicit `run`; yarn allows `yarn deploy`.
  let name;
  if (rest[0] === 'run' || rest[0] === 'run-script') name = rest[1];
  else if (tool === 'yarn' && rest.length) name = rest[0];
  if (!name) return null;

  const text = readSafely(root, 'package.json');
  if (!text) return null;

  try {
    const pkg = JSON.parse(text);
    const body = pkg.scripts && pkg.scripts[name];
    return typeof body === 'string' ? body : null;
  } catch {
    return null;
  }
}

/**
 * Strip a shell script down to the lines worth classifying.
 *
 * Comments and blank lines go. Everything else is handed back joined by
 * newline, which the parser already treats as a command separator.
 */
function meaningfulLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('::') && !l.toUpperCase().startsWith('REM '))
    .join('\n');
}

/**
 * Given one argv, return the shell text it would cause to run, or null.
 *
 * `depth` is threaded by the caller so a script that calls another script
 * terminates.
 */
function expandWrapper(argv, { cwd = process.cwd(), depth = 0 } = {}) {
  if (depth >= MAX_DEPTH) return null;

  const inline = packageScript(cwd, argv);
  if (inline) return { source: `package.json script`, text: meaningfulLines(inline) };

  const target = scriptTarget(argv);
  if (!target) return null;

  const text = readSafely(cwd, target);
  if (text === null) return { source: target, text: null, unreadable: true };

  return { source: target, text: meaningfulLines(text) };
}

module.exports = {
  expandWrapper,
  scriptTarget,
  packageScript,
  insideProject,
  meaningfulLines,
  MAX_DEPTH,
  MAX_BYTES,
};
