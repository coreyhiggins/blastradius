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

function cmdInstall() {
  const snippet = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'npx -y @coreyhiggins/blastradius hook' }],
        },
      ],
    },
  };

  const settingsPath = path.join('.claude', 'settings.json');
  process.stdout.write(`\n  Add this to ${bold(settingsPath)}:\n\n`);
  process.stdout.write(`${JSON.stringify(snippet, null, 2).split('\n').map((l) => `  ${l}`).join('\n')}\n\n`);

  if (fs.existsSync(settingsPath)) {
    process.stdout.write(`  ${dim('A settings.json already exists. Merge the hooks key rather than replacing it.')}\n\n`);
  }
  return 0;
}

async function main(argv) {
  const [command, ...rest] = argv;

  switch (command) {
    case 'check':   return cmdCheck(rest);
    case 'context': return cmdContext();
    case 'install': return cmdInstall();
    case 'hook':    return runHook();
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
