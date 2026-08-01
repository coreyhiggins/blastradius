'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { assess } = require('./classify');

// `blastradius audit` answers a question the hook cannot: what is ALREADY in
// this repository that could reach past the machine?
//
// The hook is reactive and only speaks when an agent is about to run
// something. This is proactive: it reads the commands a project has already
// committed, in package.json scripts, shell scripts, CI workflows, and
// Makefiles, and reports what a coding agent could invoke without anyone
// stopping to think.
//
// Reads only. It never executes a single line it finds.

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 400;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.next', '.nuxt', 'target', '__pycache__', '.venv', 'venv',
]);

const SHELL_EXT = new Set(['.sh', '.bash', '.zsh', '.bat', '.cmd', '.ps1']);
const YAML_EXT = new Set(['.yml', '.yaml']);

/** Walk a tree, skipping the noise, capped so a huge repo cannot hang this. */
function walk(root) {
  const found = [];

  const visit = (dir, depth) => {
    if (found.length >= MAX_FILES || depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      if (found.length >= MAX_FILES) return;
      if (e.name.startsWith('.') && e.name !== '.github') {
        if (e.isDirectory()) continue;
      }
      const full = path.join(dir, e.name);

      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        visit(full, depth + 1);
        continue;
      }

      const ext = path.extname(e.name).toLowerCase();
      if (e.name === 'package.json' || e.name === 'Makefile'
          || SHELL_EXT.has(ext) || (YAML_EXT.has(ext) && full.includes('workflows'))) {
        found.push(full);
      }
    }
  };

  visit(root, 0);
  return found;
}

/** Read a file if it is small enough. Never throws. */
function read(file) {
  try {
    if (fs.statSync(file).size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

/** Pull candidate command lines out of one file. */
function extract(file, text) {
  const rel = file;
  const out = [];
  const base = path.basename(file);
  const ext = path.extname(file).toLowerCase();

  if (base === 'package.json') {
    try {
      const pkg = JSON.parse(text);
      for (const [name, body] of Object.entries(pkg.scripts || {})) {
        if (typeof body === 'string') out.push({ file: rel, where: `scripts.${name}`, command: body });
      }
    } catch { /* a package.json that does not parse is not our problem */ }
    return out;
  }

  const lines = text.split(/\r?\n/);

  if (YAML_EXT.has(ext)) {
    // GitHub Actions `run:` steps.
    //
    // A block scalar is ONE command, not one per line. Splitting it produces
    // fragments with unbalanced quotes, and every fragment then looks
    // unparseable and gets escalated. Auditing this project's own CI file
    // that way produced six warnings, all of them artifacts of the split.
    let block = null;

    const flush = () => {
      if (block && block.lines.length) {
        out.push({ file: rel, where: `line ${block.start}`, command: block.lines.join('\n') });
      }
      block = null;
    };

    lines.forEach((line, i) => {
      const runMatch = line.match(/^(\s*)-?\s*run:\s*(\|-?|>-?)?\s*(.*)$/);
      if (runMatch) {
        flush();
        if (runMatch[2]) {
          block = { indent: runMatch[1].length, start: i + 2, lines: [] };
        } else if (runMatch[3]) {
          out.push({ file: rel, where: `line ${i + 1}`, command: runMatch[3].trim() });
        }
        return;
      }
      if (!block) return;
      if (line.trim() === '') { block.lines.push(''); return; }
      if (line.search(/\S/) <= block.indent) { flush(); return; }
      block.lines.push(line.trim());
    });
    flush();
    return out;
  }

  // Shell scripts and Makefiles.
  //
  // Heredoc bodies are text, not commands. A usage message that happens to
  // contain the word "restarts" is not a restart, and counting it inflates
  // the total so the real ratio ("3 of 40") stops meaning anything.
  let heredoc = null;

  lines.forEach((line, i) => {
    const t = line.trim();

    if (heredoc) {
      if (t === heredoc || t === `${heredoc};`) heredoc = null;
      return;
    }

    const open = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (open) { heredoc = open[1]; return; }

    if (!t) return;
    if (t.startsWith('#') || t.startsWith('::') || /^REM\s/i.test(t)) return;
    if (/^(set|export|local|declare|readonly|if|fi|else|elif|then|do|done|case|esac|function|echo|printf|return|shift|\}|\{|\)|;;)/i.test(t)) return;
    // Bare assignments are not commands. `FOO=$(rm -rf x)` still is, so only
    // skip when there is no command substitution in the value.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) && !/\$\(|`/.test(t)) return;
    if (base === 'Makefile' && !line.startsWith('\t')) return;

    out.push({ file: rel, where: `line ${i + 1}`, command: t.replace(/^[\t@-]+/, '') });
  });

  return out;
}

/**
 * Audit a directory. Returns findings sorted worst first, plus counts.
 */
function audit(root = process.cwd(), options = {}) {
  const files = walk(path.resolve(root));
  const findings = [];
  let scanned = 0;

  for (const file of files) {
    const text = read(file);
    if (text === null) continue;

    for (const candidate of extract(file, text)) {
      if (!candidate.command || candidate.command.length > 500) continue;
      scanned += 1;

      const result = assess(candidate.command, { cwd: root, ...options });

      // Escalating on unparseable input is right for the live hook, where the
      // thing we failed to read is genuinely about to run. It is wrong here:
      // static extraction produces fragments, and a fragment we misread is
      // our bug, not the project's risk. Reporting it teaches people to
      // ignore the output.
      if (result.unparseable) continue;

      if (['confirm', 'danger'].includes(result.severity)) {
        findings.push({
          ...candidate,
          file: path.relative(root, file) || path.basename(file),
          severity: result.severity,
          radius: result.radius,
          reasons: result.reasons,
        });
      }
    }
  }

  const order = { danger: 0, confirm: 1 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return { findings, scanned, files: files.length };
}

module.exports = { audit, walk, extract, SKIP_DIRS };
