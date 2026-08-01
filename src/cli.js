'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { assess, readContext } = require('./classify');
const { runHook } = require('./hook');

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
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

  if (result.reasons.length) {
    lines.push('');
    result.reasons.forEach((r) => lines.push(`  ${c(badge.color, '-')} ${r}`));
  }

  if (result.severity === 'ok') {
    lines.push(`  ${dim(result.radius === 'local'
      ? 'nothing here leaves the project'
      : 'reaches beyond this machine, but changes no state')}`);
  }

  lines.push('');
  return lines.join('\n');
}

function cmdCheck(args) {
  const command = args.join(' ').trim();
  if (!command) {
    process.stderr.write('blastradius: nothing to check\n');
    return 1;
  }
  const result = assess(command);
  process.stdout.write(renderResult(command, result));
  return ['confirm', 'danger'].includes(result.severity) ? 2 : 0;
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
