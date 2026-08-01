'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { assess, readContext } = require('./classify');
const { guidanceFor } = require('./rules');
const { audit } = require('./audit');
const { runHook } = require('./hook');

// FORCE_COLOR lets docs tooling and CI capture the coloured output that a
// terminal would show. Without it, anything that pipes stdout gets plain
// text, which is right for scripts and useless for a screenshot.
const COLOR = (process.env.FORCE_COLOR === '1' || process.stdout.isTTY)
  && !process.env.NO_COLOR;
const c = (code, text) => (COLOR ? `[${code}m${text}[0m` : text);
const dim = (t) => c('2', t);
const bold = (t) => c('1', t);

const BADGE = {
  ok:      { label: 'ok',      color: '32' },
  notice:  { label: 'notice',  color: '33' },
  confirm: { label: 'confirm', color: '33' },
  danger:  { label: 'DANGER',  color: '31' },
};

const HELP = `
${bold('blastradius')} - how far does this command reach?

  Guards AI coding agents against commands that leave your machine.
  Your editor's undo covers files. Nothing covers a terraform destroy.

${bold('Usage')}
  blastradius check "<command>"     Classify a command
  blastradius explain "<command>"   Classify it, and say what you cannot undo
  blastradius audit [dir]           Find risky commands already in this project
  blastradius context               Show the environment commands run against
  blastradius hook                  PreToolUse hook (reads JSON on stdin)
  blastradius install               Print the Claude Code settings snippet

${bold('Blast radius')}
  local     only the working directory      your editor can undo it
  machine   this box, outside the project   restore or reinstall
  remote    another host, cluster, account  someone else feels it

${bold('Exit codes for `check`')}
  0  ok or notice      2  confirm or danger
`;

function renderResult(command, result) {
  const badge = BADGE[result.severity];
  const lines = [];

  lines.push('');
  lines.push(`  ${c(badge.color, bold(badge.label.padEnd(8)))}${command}`);
  lines.push(`  ${dim(`reach: ${result.radius}`)}`);

  // An `ok` verdict gets one line and nothing else. It is the most common
  // outcome by far, and the whole promise of the tool is that it does not
  // editorialise about work you are allowed to do. Listing why a safe
  // command is safe is exactly the noise that gets a guard uninstalled.
  if (result.severity === 'ok') {
    lines.push(`  ${dim(result.radius === 'local'
      ? 'stays inside the project'
      : 'reaches beyond this machine, but changes no state')}`);
  } else if (result.reasons.length) {
    lines.push('');
    result.reasons.forEach((r) => lines.push(`  ${c(badge.color, '-')} ${r}`));
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * The long form. `check` tells you a command is risky; `explain` tells you
 * what that actually means, which is the difference between a warning
 * someone dismisses and one they act on.
 */
function renderExplain(command, result) {
  const badge = BADGE[result.severity];
  const out = [];

  out.push('');
  out.push(`  ${c(badge.color, bold(badge.label.padEnd(8)))}${command}`);
  out.push(`  ${dim(`reach: ${result.radius}`)}`);

  if (result.severity === 'ok') {
    out.push('');
    out.push(`  ${dim(result.radius === 'local'
      ? 'Nothing here leaves the project. Your editor can undo it.'
      : 'This reaches beyond your machine, but only reads. Nothing changes.')}`);
    out.push('');
    return out.join('\n');
  }

  const acted = result.findings.filter((f) => f.destructive);
  const seen = new Set();

  out.push('');
  out.push(`  ${bold('What it does')}`);
  acted.forEach((f) => out.push(`    ${f.argv.slice(0, 5).join(' ')} - ${f.why}`));

  for (const f of acted) {
    const g = guidanceFor(f.command, f.radius);
    const key = `${g.changes}|${g.unrecoverable}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push('');
    out.push(`  ${bold('What changes')}`);
    out.push(`    ${wrap(g.changes)}`);
    out.push('');
    out.push(`  ${c('31', bold('What you cannot get back'))}`);
    out.push(`    ${wrap(g.unrecoverable)}`);
    out.push('');
    out.push(`  ${bold('Before you run it')}`);
    g.before.forEach((b) => out.push(`    ${dim('-')} ${b}`));
  }

  out.push('');
  return out.join('\n');
}

/** Soft-wrap at 72 columns, indented to match the caller. */
function wrap(text, indent = '    ') {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + w).length > 72) { lines.push(line.trimEnd()); line = ''; }
    line += `${w} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join(`\n${indent}`);
}

function cmdCheck(args, { explain = false } = {}) {
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const command = args.filter((a) => !a.startsWith('--')).join(' ').trim();

  if (!command) {
    process.stderr.write('blastradius: nothing to check\n');
    return 1;
  }

  const result = assess(command);
  const long = explain || flags.has('--explain');
  process.stdout.write(long ? renderExplain(command, result) : renderResult(command, result));
  return ['confirm', 'danger'].includes(result.severity) ? 2 : 0;
}

function cmdAudit(args) {
  const root = args.find((a) => !a.startsWith('-')) || process.cwd();
  const { findings, scanned, files } = audit(root);

  process.stdout.write('\n');

  if (!scanned) {
    process.stdout.write(`  ${dim('No commands found. Looked in package.json scripts, shell scripts, CI workflows, and Makefiles.')}\n\n`);
    return 0;
  }

  if (!findings.length) {
    process.stdout.write(`  ${c('32', bold('Nothing reaches past this machine.'))}\n`);
    process.stdout.write(`  ${dim(`${scanned} commands across ${files} files, none destructive beyond the project.`)}\n\n`);
    return 0;
  }

  let lastFile = '';
  for (const f of findings) {
    if (f.file !== lastFile) {
      process.stdout.write(`\n  ${bold(f.file)}\n`);
      lastFile = f.file;
    }
    const badge = BADGE[f.severity];
    process.stdout.write(`    ${c(badge.color, badge.label.padEnd(8))}${dim(f.where.padEnd(16))}${f.command.slice(0, 60)}\n`);
    if (f.reasons[0]) process.stdout.write(`    ${dim(`         ${f.reasons[0].slice(0, 88)}`)}\n`);
  }

  const danger = findings.filter((f) => f.severity === 'danger').length;
  process.stdout.write(`\n  ${bold(`${findings.length} of ${scanned} commands`)} reach past this machine`);
  process.stdout.write(danger ? `, ${c('31', `${danger} at a target that looks like production`)}` : '');
  process.stdout.write(`\n  ${dim('Run blastradius explain "<command>" on any of them for detail.')}\n\n`);

  return findings.length ? 2 : 0;
}

function cmdContext() {
  const ctx = readContext();
  const entries = Object.entries(ctx);
  if (!entries.length) {
    process.stdout.write(`\n  ${dim('no cluster, workspace, or cloud profile detected')}\n\n`);
    return 0;
  }
  process.stdout.write('\n');
  entries.forEach(([k, v]) => {
    process.stdout.write(`  ${bold(k.padEnd(20))}${v}\n`);
  });
  process.stdout.write('\n');
  return 0;
}

const INSTALLERS = {
  'claude-code': {
    file: path.join('.claude', 'settings.json'),
    note: 'Merge the hooks key if the file already exists.',
    snippet: {
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'npx -y @coreyhiggins/blastradius hook' }],
        }],
      },
    },
  },
  cursor: {
    file: path.join('.cursor', 'hooks.json'),
    note: 'Project hooks need the workspace to be trusted. ~/.cursor/hooks.json works globally.',
    snippet: {
      version: 1,
      hooks: {
        beforeShellExecution: [{
          command: 'npx -y @coreyhiggins/blastradius hook-cursor',
          timeout: 10,
        }],
      },
    },
  },
  codex: {
    file: path.join('.codex', 'hooks.json'),
    note: 'Codex also needs "[features]\\nhooks = true" in ~/.codex/config.toml.\n  Codex hooks cannot prompt, so blastradius blocks instead of asking there.',
    snippet: {
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{
            type: 'command',
            command: 'npx -y @coreyhiggins/blastradius hook-codex',
            timeout: 10,
          }],
        }],
      },
    },
  },
};

function cmdInstall(harness) {
  const key = (harness || 'claude-code').toLowerCase();
  const target = INSTALLERS[key];

  if (!target) {
    process.stderr.write(`blastradius: unknown harness "${harness}"\n`);
    process.stdout.write(`\n  Supported: ${Object.keys(INSTALLERS).join(', ')}\n`);
    process.stdout.write(`  Example: ${bold('blastradius install cursor')}\n\n`);
    return 1;
  }

  process.stdout.write(`\n  Add this to ${bold(target.file)}:\n\n`);
  process.stdout.write(`${JSON.stringify(target.snippet, null, 2).split('\n').map((l) => `  ${l}`).join('\n')}\n\n`);
  process.stdout.write(`  ${dim(target.note)}\n`);

  if (fs.existsSync(target.file)) {
    process.stdout.write(`  ${dim('That file already exists, so merge rather than replace.')}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

async function main(argv) {
  const [command, ...rest] = argv;

  switch (command) {
    case 'check':   return cmdCheck(rest);
    case 'explain': return cmdCheck(rest, { explain: true });
    case 'audit':   return cmdAudit(rest);
    case 'context': return cmdContext();
    case 'install': return cmdInstall(rest[0]);
    case 'hook':    return runHook('claude-code');
    case 'hook-cursor': return runHook('cursor');
    case 'hook-codex':  return runHook('codex');
    case '--version':
    case '-v': {
      const pkg = require('../package.json');
      process.stdout.write(`${pkg.version}\n`);
      return 0;
    }
    case undefined:
    case '--help':
    case '-h':
      process.stdout.write(`${HELP}\n`);
      return 0;
    default:
      process.stderr.write(`blastradius: unknown command "${command}"\n`);
      process.stdout.write(`${HELP}\n`);
      return 1;
  }
}

module.exports = { main, renderResult };
