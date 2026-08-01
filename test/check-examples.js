#!/usr/bin/env node
'use strict';

// Every config in examples/ must parse cleanly, catch what it claims to
// catch, and stay silent on ordinary work.
//
// A broken example is worse than no example. Someone copies it, it guards
// nothing, and they believe they are covered. This runs in CI so that can
// never ship.
//
//   node test/check-examples.js

const fs = require('node:fs');
const path = require('node:path');

const { parseConfig } = require('../src/config');
const { assess } = require('../src/classify');

const DIR = path.join(__dirname, '..', 'examples');

// Ordinary work. No config may interrupt any of these.
const ROUTINE = [
  'npm run build', 'npm test', 'npm install', 'git status', 'git diff',
  'git commit -m wip', 'git push origin main', 'git stash', 'ls -la',
  'cat README.md', 'rm -rf ./dist', 'node --check src/app.js',
  'systemctl status nginx', 'kubectl get pods', 'terraform plan',
  'cat .env.example', 'npx tsc --noEmit',
];

// What each config exists to catch. Keep these honest: if a rule is removed,
// its case here should fail rather than being quietly deleted.
const MUST_FIRE = {
  'game-server.json': [
    'systemctl restart mc-cobblemon',
    'rm -rf /srv/mc/world',
    'tmux send-keys -t server "/stop" Enter',
  ],
  'web-deploy.json': [
    'sudo systemctl reload nginx',
    'ln -sfn /var/www/releases/20260801 /var/www/current',
    'rm -rf /var/www/html',
    'cat /etc/ssl/private/site.key',
  ],
  'data-team.json': [
    'psql -h warehouse -c "DROP TABLE events"',
    'gunzip -c dump.sql.gz | psql analytics',
    'aws s3 cp customer_export.csv s3://bucket/',
  ],
  'solo-managed.json': [
    'prisma migrate reset',
    'vercel --prod',
    'git reset --hard HEAD~3',
    'npm publish',
    'rm .env',
  ],
};

let failures = 0;
const configs = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));

if (!configs.length) {
  console.error('no example configs found, which is itself a failure');
  process.exit(1);
}

for (const file of configs) {
  const cfg = parseConfig(fs.readFileSync(path.join(DIR, file), 'utf8'), file);
  const problems = [];

  cfg.errors.forEach((e) => problems.push(`config error: ${e}`));

  for (const cmd of ROUTINE) {
    const r = assess(cmd, { context: {}, config: cfg });
    if (['confirm', 'danger'].includes(r.severity)) {
      problems.push(`false positive on "${cmd}" (${r.severity}) via ${(r.customRules || []).join(', ')}`);
    }
  }

  const expected = MUST_FIRE[file];
  if (!expected) {
    problems.push('no MUST_FIRE cases defined for this config, so nothing verifies it works');
  } else {
    for (const cmd of expected) {
      const r = assess(cmd, { context: {}, config: cfg });
      if (!['confirm', 'danger'].includes(r.severity)) {
        problems.push(`missed "${cmd}" (got ${r.severity})`);
      }
    }
  }

  if (problems.length) {
    failures += problems.length;
    console.error(`\n  FAIL  ${file} (${cfg.rules.length} rules)`);
    problems.forEach((p) => console.error(`        ${p}`));
  } else {
    console.log(`  ok    ${file} (${cfg.rules.length} rules)`);
  }
}

console.log(`\n  ${configs.length} configs checked, ${failures} problems\n`);
process.exit(failures ? 1 : 0);
