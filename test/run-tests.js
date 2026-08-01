'use strict';

// No test framework on purpose: this package has zero dependencies at
// runtime and at test time, so `node test/run-tests.js` works on a clean
// checkout with nothing installed.
//
// The bypass section is the important one. Classification mistakes make the
// tool noisy; bypasses make it a lie.

const assert = require('node:assert');

const { splitCommands, toArgv, expand, basename } = require('../src/parse');
const { assess } = require('../src/classify');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push(`${name}\n    ${err.message}`);
  }
}

// A fixed context so tests never depend on the machine running them.
const CTX = {
  kubeContext: 'gke_acme_us-east1_production',
  terraformWorkspace: 'prod',
  awsProfile: 'staging',
};
const DEV_CTX = { kubeContext: 'kind-local', terraformWorkspace: 'dev' };

// config: null keeps these hermetic. Without it, a .blastradius.json sitting
// in someone's home directory would silently change test outcomes.
const at = (line, context = DEV_CTX) => assess(line, { context, config: null });

// ---------------------------------------------------------------- parsing --

test('splits on unquoted separators', () => {
  const { segments } = splitCommands('echo a && rm -rf /tmp/x ; ls');
  assert.deepStrictEqual(segments, ['echo a', 'rm -rf /tmp/x', 'ls']);
});

test('does NOT split on a separator inside double quotes', () => {
  const { segments } = splitCommands('echo "a && b"');
  assert.strictEqual(segments.length, 1);
});

test('does NOT split on a separator inside single quotes', () => {
  const { segments } = splitCommands("echo 'a ; b | c'");
  assert.strictEqual(segments.length, 1);
});

test('an escaped separator does not split', () => {
  const { segments } = splitCommands('echo a \\&\\& b');
  assert.strictEqual(segments.length, 1);
});

test('unbalanced quoting is reported rather than guessed at', () => {
  const { unbalanced } = splitCommands('echo "never closed');
  assert.strictEqual(unbalanced, true);
});

test('command substitution is captured for separate inspection', () => {
  const { substitutions } = splitCommands('echo $(rm -rf /etc)');
  assert.deepStrictEqual(substitutions, ['rm -rf /etc']);
});

test('backtick substitution is captured too', () => {
  const { substitutions } = splitCommands('echo `terraform destroy`');
  assert.deepStrictEqual(substitutions, ['terraform destroy']);
});

test('substitution inside double quotes is still live', () => {
  const { substitutions } = splitCommands('echo "$(kubectl delete ns x)"');
  assert.deepStrictEqual(substitutions, ['kubectl delete ns x']);
});

test('single quotes make substitution inert, so it is not extracted', () => {
  const { substitutions } = splitCommands("echo '$(rm -rf /)'");
  assert.deepStrictEqual(substitutions, []);
});

test('argv drops leading env assignments', () => {
  assert.deepStrictEqual(toArgv('FOO=1 BAR=2 terraform destroy'), ['terraform', 'destroy']);
});

test('argv unwraps sudo and its flags', () => {
  assert.deepStrictEqual(toArgv('sudo -u deploy systemctl stop nginx'), ['systemctl', 'stop', 'nginx']);
});

test('argv unwraps stacked wrappers', () => {
  assert.deepStrictEqual(toArgv('sudo env FOO=1 rm -rf /var'), ['rm', '-rf', '/var']);
});

test('basename strips paths and .exe', () => {
  assert.strictEqual(basename('/usr/bin/kubectl'), 'kubectl');
  assert.strictEqual(basename('C:\\tools\\git.EXE'), 'git');
});

// ---------------------------------------------------------------- bypasses --

test('BYPASS: destructive command hidden in a substitution is still caught', () => {
  const r = at('echo $(terraform destroy -auto-approve)');
  assert.notStrictEqual(r.severity, 'ok', 'substitution payload was ignored');
});

test('BYPASS: full path does not evade the rule', () => {
  const r = at('/usr/local/bin/kubectl delete ns payments');
  assert.notStrictEqual(r.severity, 'ok');
});

test('BYPASS: sudo prefix does not evade the rule', () => {
  const r = at('sudo terraform destroy');
  assert.notStrictEqual(r.severity, 'ok');
});

test('BYPASS: destructive command later in a chain is caught', () => {
  const r = at('cd /tmp && ls -la && kubectl delete deploy api');
  assert.notStrictEqual(r.severity, 'ok');
});

test('BYPASS: ssh payload is judged on its own merits', () => {
  const r = at('ssh web01 "rm -rf /var/www"');
  assert.notStrictEqual(r.severity, 'ok');
  assert.ok(r.findings.some((f) => f.command === 'rm'), 'payload was not inspected');
});

test('BYPASS: ssh with flags before the host still finds the payload', () => {
  const r = at('ssh -i ~/.ssh/id_ed25519 -p 2222 deploy@web01 "systemctl stop nginx"');
  assert.ok(r.findings.some((f) => f.command === 'systemctl'), 'payload after flags was missed');
});

test('BYPASS: unparseable input is escalated, never waved through', () => {
  const r = at('rm -rf "/var/log');
  assert.strictEqual(r.unparseable, true);
  assert.strictEqual(r.severity, 'confirm');
});

test('a quoted string that only LOOKS dangerous is not a finding', () => {
  const r = at('echo "run terraform destroy when ready"');
  assert.strictEqual(r.severity, 'ok', 'matched text inside a quoted argument');
});

// ---------------------------------------------------------- classification --

test('read-only remote commands do not interrupt', () => {
  assert.strictEqual(at('kubectl get pods').severity, 'ok');
  assert.strictEqual(at('terraform plan').severity, 'ok');
  assert.strictEqual(at('aws s3 ls').severity, 'ok');
  assert.strictEqual(at('git push origin main').severity, 'ok');
});

test('deleting inside the project is local and does not interrupt', () => {
  assert.strictEqual(at('rm -rf ./build').severity, 'ok');
  assert.strictEqual(at('rm -rf node_modules').severity, 'ok');
});

test('deleting outside the project escalates to machine', () => {
  const r = at('rm -rf /var/lib/mysql');
  assert.strictEqual(r.severity, 'notice');
  assert.strictEqual(r.radius, 'machine');
});

test('parent traversal counts as leaving the project', () => {
  assert.strictEqual(at('rm -rf ../../shared').radius, 'machine');
});

test('home-relative paths count as leaving the project', () => {
  assert.strictEqual(at('rm -rf ~/.config').radius, 'machine');
});

test('stopping a service is a machine-level notice', () => {
  assert.strictEqual(at('systemctl stop nginx').severity, 'notice');
});

// --- found while bug-hunting another tool, 2026-08-01 ----------------------
// Two holes in our own classifier, found by running the same corpus against
// ourselves before filing a report on someone else's project.

test('SELF-AUDIT: a path-qualified env wrapper is unwrapped', () => {
  // The bypass that was live in cc-safety-net. Ours strips by basename, so it
  // was already covered, but nothing pinned it.
  assert.notStrictEqual(at('/usr/bin/env rm -rf /var/www').severity, 'ok');
  assert.notStrictEqual(at('sudo /usr/bin/env rm -rf /var/www').severity, 'ok');
  assert.notStrictEqual(at('/usr/bin/env.exe rm -rf /var/www').severity, 'ok');
});

test('SELF-AUDIT: git reset --hard is destructive, not quietly local', () => {
  // Calling this `local` implied an editor could undo it. Nothing can: it
  // destroys work git was never told about.
  const r = at('git reset --hard HEAD~3');
  assert.strictEqual(r.severity, 'notice');
  assert.ok(r.reasons.join(' ').includes('never knew about it'));
});

test('SELF-AUDIT: git clean and stash clear count too', () => {
  assert.strictEqual(at('git clean -fdx').severity, 'notice');
  assert.strictEqual(at('git stash clear').severity, 'notice');
});

test('SELF-AUDIT: the colon refspec deletes a remote branch', () => {
  // `git push origin :main` is a delete wearing different clothes. We caught
  // the + form and missed this one.
  const r = at('git push origin :main');
  assert.strictEqual(r.severity, 'confirm');
  assert.ok(r.reasons.join(' ').includes('deletes a branch'));
});

test('SELF-AUDIT: ordinary git work stays silent', () => {
  assert.strictEqual(at('git reset HEAD~1').severity, 'ok', 'a soft reset is not destructive');
  assert.strictEqual(at('git clean -n').severity, 'ok', 'a dry run is not destructive');
  assert.strictEqual(at('git checkout -b feature/new').severity, 'ok');
  assert.strictEqual(at('git stash').severity, 'ok');
  assert.strictEqual(at('git push origin main').severity, 'ok');
});

// --- regressions from the 166-command audit, 2026-08-01 -------------------

test('AUDIT: restart counts as destructive, so configs can escalate it', () => {
  // It stays at `notice`, so a routine restart never interrupts. The point is
  // that it is now VISIBLE: before this, every restart in the corpus was
  // invisible to the classifier and no custom rule could reach it.
  const r = at('systemctl restart nginx');
  assert.strictEqual(r.severity, 'notice');
  assert.ok(r.reasons.join(' ').includes('interrupts'));
});

test('AUDIT: a database restore through a pipe is destructive', () => {
  // The single most destructive line in the audit corpus, previously `ok`.
  const r = at('gunzip -c all-databases.sql.gz | mysql');
  assert.notStrictEqual(r.severity, 'ok', 'a full database restore classified as harmless');
});

test('AUDIT: a database client NOT fed by a pipe stays quiet', () => {
  assert.strictEqual(at('mysql -h 127.0.0.1 arcbound').severity, 'ok');
});

test('AUDIT: || is not a pipe and must not imply a restore', () => {
  assert.strictEqual(at('false || mysql arcbound').severity, 'ok');
});

test('AUDIT: bitvise sftpc and sexec reach another machine', () => {
  assert.strictEqual(at('sexec deploy@host -cmd="systemctl stop nginx"').radius, 'remote');
  assert.strictEqual(at('sftpc deploy@host -cmd="put app.jar"').radius, 'remote');
});

test('docker compose down -v is destructive because volumes hold data', () => {
  assert.strictEqual(at('docker compose down -v').severity, 'notice');
});

test('docker compose down without -v is not destructive', () => {
  assert.strictEqual(at('docker compose down').severity, 'ok');
});

test('force push is remote and destructive', () => {
  const r = at('git push --force origin main');
  assert.strictEqual(r.severity, 'confirm');
  assert.strictEqual(r.radius, 'remote');
});

test('a + refspec is recognised as a force push', () => {
  assert.strictEqual(at('git push origin +main').severity, 'confirm');
});

test('force-with-lease still counts, with softer wording', () => {
  const r = at('git push --force-with-lease origin main');
  assert.strictEqual(r.severity, 'confirm');
  assert.ok(r.reasons.join(' ').includes('lease-checked'));
});

test('a database client pointed at a remote host is remote', () => {
  const r = at('mysql -h db.internal.acme.com -e "DROP DATABASE billing"');
  assert.strictEqual(r.radius, 'remote');
  assert.strictEqual(r.severity, 'confirm');
});

test('the same client pointed at localhost is only machine-level', () => {
  const r = at('mysql -h 127.0.0.1 -e "DROP DATABASE billing"');
  assert.strictEqual(r.radius, 'machine');
});

test('joined short flags are read correctly', () => {
  assert.strictEqual(at('mysql -hdb.prod.internal -e "DROP DATABASE x"').radius, 'remote');
});

test('rsync is only remote when an argument names a host', () => {
  assert.strictEqual(at('rsync -a --delete ./src ./dst').radius, 'machine');
  assert.strictEqual(at('rsync -a --delete ./src web01:/srv/app').radius, 'remote');
});

// -------------------------------------------------------- context awareness --

test('a production kube context raises confirm to danger', () => {
  const r = assess('kubectl delete ns payments', { context: CTX, config: null });
  assert.strictEqual(r.severity, 'danger');
  assert.ok(r.reasons[0].includes('production'), 'did not name the production target');
});

test('the same command against a local cluster stays at confirm', () => {
  const r = assess('kubectl delete ns payments', { context: DEV_CTX, config: null });
  assert.strictEqual(r.severity, 'confirm');
});

test('a prod terraform workspace raises danger', () => {
  const r = assess('terraform destroy', { context: CTX, config: null });
  assert.strictEqual(r.severity, 'danger');
});

test('the incident that started this: terraform destroy against prod', () => {
  const r = assess('terraform destroy -auto-approve', { context: { terraformWorkspace: 'production' }, config: null });
  assert.strictEqual(r.severity, 'danger');
  assert.strictEqual(r.radius, 'remote');
});

test('reasons are human readable and name the command', () => {
  const r = assess('kubectl delete ns payments', { context: CTX, config: null });
  assert.ok(r.reasons.some((x) => x.includes('kubectl delete')), 'reason did not name the command');
});

// ------------------------------------------------------------ custom rules --

const { parseConfig, normalizeRule } = require('../src/config');

const cfg = (rules) => parseConfig(JSON.stringify({ rules }), 'test');

const ARC_RULES = [
  {
    id: 'arc-one-untouchable',
    when: { pattern: 'servers/arcbound|Xmx30G' },
    severity: 'danger',
    why: 'Arc One production JVM. Owner rule: do not touch.',
  },
  {
    id: 'live-game-servers',
    when: { pattern: '\\bmc-[a-z]+' },
    severity: 'danger',
    why: 'Live game server with players connected. Send a countdown first.',
  },
];

test('a custom rule escalates a command the built-ins rate lower', () => {
  const config = cfg(ARC_RULES);
  assert.strictEqual(config.errors.length, 0, config.errors.join('; '));

  const before = assess('systemctl restart mc-cobblemon', { context: DEV_CTX, config: null });
  const after = assess('systemctl restart mc-cobblemon', { context: DEV_CTX, config });

  // Baseline is `notice`: a restart is destructive but machine-scoped, so the
  // built-ins never interrupt for it. The config knows this particular service
  // has players connected, which is the knowledge the built-ins cannot have.
  assert.strictEqual(before.severity, 'notice', 'baseline changed, update this test');
  assert.strictEqual(after.severity, 'danger');
  assert.ok(after.reasons[0].includes('players connected'));
});

test('a custom rule matches after sudo is unwrapped', () => {
  const r = assess('sudo -u deploy systemctl stop mc-cobblemon', { context: DEV_CTX, config: cfg(ARC_RULES) });
  assert.strictEqual(r.severity, 'danger');
});

test('SECURITY: a custom rule cannot downgrade a built-in verdict', () => {
  // The agent this guards can write files. If config could lower severity,
  // writing .blastradius.json would be the first bypass anyone found.
  const sneaky = cfg([{
    id: 'please-allow-this',
    when: { command: 'terraform' },
    severity: 'notice',
    why: 'attempting to weaken a remote destructive verdict',
  }]);

  const r = assess('terraform destroy', { context: DEV_CTX, config: sneaky });
  assert.strictEqual(r.severity, 'confirm', 'config downgraded a built-in verdict');
});

test('SECURITY: severity cannot be set to ok', () => {
  const { error } = normalizeRule({ id: 'x', when: { command: 'rm' }, severity: 'ok', why: 'nope' }, 0);
  assert.ok(error, '"ok" was accepted as a severity');
});

test('an invalid regex is rejected without killing the whole config', () => {
  const config = cfg([
    { id: 'broken', when: { pattern: '([unclosed' }, severity: 'danger', why: 'x' },
    ...ARC_RULES,
  ]);
  assert.strictEqual(config.errors.length, 1);
  assert.strictEqual(config.rules.length, 2, 'a good rule was dropped alongside the bad one');
});

test('an overlong pattern is refused', () => {
  const config = cfg([{ id: 'huge', when: { pattern: 'a'.repeat(501) }, severity: 'danger', why: 'x' }]);
  assert.strictEqual(config.rules.length, 0);
  assert.ok(config.errors[0].includes('longer than'));
});

test('a rule without a human explanation is refused', () => {
  const config = cfg([{ id: 'terse', when: { command: 'rm' }, severity: 'danger' }]);
  assert.strictEqual(config.rules.length, 0);
  assert.ok(config.errors[0].includes('why'));
});

test('malformed JSON produces a warning, never a crash', () => {
  const config = parseConfig('{ not json', 'test');
  assert.strictEqual(config.rules.length, 0);
  assert.ok(config.errors[0].includes('not valid JSON'));
});

test('a broken config still leaves the built-in rules working', () => {
  const config = parseConfig('{ not json', 'test');
  const r = assess('terraform destroy', { context: DEV_CTX, config });
  assert.strictEqual(r.severity, 'confirm', 'a broken config disabled the guard');
});

test('custom rules do not fire on unrelated commands', () => {
  // `systemctl restart nginx` is deliberately `ok` in the built-ins: restarting
  // a service after a config change is routine, and flagging it would make the
  // tool noisy enough to uninstall. Whether a restart is a big deal depends
  // entirely on what the service is, which is knowledge the built-ins cannot
  // have and a project config can. That is the whole argument for custom rules.
  const r = assess('systemctl restart nginx', { context: DEV_CTX, config: cfg(ARC_RULES) });
  assert.strictEqual(r.severity, 'notice', 'a live-server rule matched an unrelated service');
});

// ---------------------------------------------------------------- wrappers --

const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');
const { expandWrapper, insideProject, scriptTarget } = require('../src/script');

// A throwaway project so wrapper tests never depend on the repo they run in.
const FIXTURE = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'blastradius-'));
fs.writeFileSync(pathMod.join(FIXTURE, 'deploy.sh'),
  '#!/bin/bash\n# ship it\nset -e\nnpm run build\nrsync -a --delete ./dist deploy@web01:/srv/app\n');
fs.writeFileSync(pathMod.join(FIXTURE, 'build.sh'),
  '#!/bin/bash\nrm -rf ./dist\nnpm run build\n');
fs.writeFileSync(pathMod.join(FIXTURE, 'package.json'),
  JSON.stringify({ scripts: { build: 'node build.js', deploy: 'bash deploy.sh' } }));

const inFixture = (line) => assess(line, { context: { cwd: FIXTURE }, cwd: FIXTURE, config: null });

test('WRAPPER: a deploy script is judged on what is inside it', () => {
  const r = inFixture('./deploy.sh');
  assert.notStrictEqual(r.severity, 'ok', 'an opaque deploy script was waved through');
  assert.strictEqual(r.radius, 'remote');
  assert.ok(r.reasons.join(' ').includes('deploy.sh'), 'did not name the script');
});

test('WRAPPER: a harmless build script stays quiet', () => {
  // The whole point of reading the file rather than flagging every script.
  assert.strictEqual(inFixture('./build.sh').severity, 'ok');
});

test('WRAPPER: bash script.sh resolves the same way', () => {
  assert.notStrictEqual(inFixture('bash deploy.sh').severity, 'ok');
});

test('WRAPPER: npm run deploy is read from package.json', () => {
  const r = inFixture('npm run deploy');
  assert.notStrictEqual(r.severity, 'ok', 'npm run deploy was waved through');
});

test('WRAPPER: npm run build stays quiet', () => {
  assert.strictEqual(inFixture('npm run build').severity, 'ok');
});

test('WRAPPER: an unreadable script is surfaced rather than ignored', () => {
  const r = inFixture('./does-not-exist.sh');
  assert.ok(r.findings.some((f) => f.wrapper), 'missing wrapper finding');
  assert.ok(r.findings.some((f) => (f.why || '').includes('could not be read')));
});

test('SECURITY: a wrapper cannot read outside the project', () => {
  assert.strictEqual(insideProject(FIXTURE, pathMod.join(FIXTURE, 'deploy.sh')), true);
  assert.strictEqual(insideProject(FIXTURE, '/etc/shadow'), false);
  assert.strictEqual(insideProject(FIXTURE, pathMod.join(FIXTURE, '..', '..', 'secrets.sh')), false);
});

test('SECURITY: traversal in the command itself is refused', () => {
  const r = inFixture('bash ../../../etc/evil.sh');
  const read = r.findings.filter((f) => f.wrapper && !(f.why || '').includes('could not be read'));
  assert.strictEqual(read.length, 0, 'read a script outside the project');
});

test('scriptTarget recognises the shapes and rejects the rest', () => {
  assert.strictEqual(scriptTarget(['./deploy.sh']), './deploy.sh');
  assert.strictEqual(scriptTarget(['bash', '-e', 'scripts/go.sh']), 'scripts/go.sh');
  assert.strictEqual(scriptTarget(['node', 'index.js']), null);
  assert.strictEqual(scriptTarget(['ls', '-la']), null);
});

test('WRAPPER: recursion terminates on a self-referential script', () => {
  const loop = pathMod.join(FIXTURE, 'loop.sh');
  fs.writeFileSync(loop, '#!/bin/bash\nbash loop.sh\n');
  // The assertion is simply that this returns rather than hanging or blowing
  // the stack.
  const r = inFixture('bash loop.sh');
  assert.ok(r, 'self-referential wrapper did not terminate');
});

// ------------------------------------------------------------------- audit --

const { audit, extract } = require('../src/audit');

// A project with genuinely risky commands, plus routine ones it must ignore.
const PROJ = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'blastradius-audit-'));
fs.mkdirSync(pathMod.join(PROJ, '.github', 'workflows'), { recursive: true });

fs.writeFileSync(pathMod.join(PROJ, 'package.json'), JSON.stringify({
  scripts: {
    build: 'node build.js',
    test: 'node test.js',
    deploy: 'rsync -a --delete ./dist deploy@web01:/srv/app',
    nuke: 'kubectl delete ns payments',
  },
}));

fs.writeFileSync(pathMod.join(PROJ, 'release.sh'), [
  '#!/usr/bin/env bash',
  '# a comment mentioning rm -rf / which is not a command',
  'set -euo pipefail',
  'VERSION="1.2.3"',
  'cat <<EOF',
  'This help text says it will destroy everything, but it is only text.',
  'terraform destroy',
  'EOF',
  'npm run build',
  'git push --force origin main',
].join('\n'));

fs.writeFileSync(pathMod.join(PROJ, '.github', 'workflows', 'ci.yml'), [
  'jobs:',
  '  build:',
  '    steps:',
  '      - run: npm test',
  '      - name: multi',
  '        run: |',
  '          echo "a && b"',
  '          npm run build',
].join('\n'));

test('AUDIT: finds risky commands in package.json scripts', () => {
  const { findings } = audit(PROJ, { config: null });
  const cmds = findings.map((f) => f.command).join(' | ');
  assert.ok(cmds.includes('rsync'), 'missed the deploy script');
  assert.ok(cmds.includes('kubectl delete'), 'missed the kubectl delete');
});

test('AUDIT: finds risky commands in shell scripts', () => {
  const { findings } = audit(PROJ, { config: null });
  assert.ok(findings.some((f) => f.command.includes('--force')), 'missed the force push');
});

test('AUDIT: ignores routine commands', () => {
  const { findings } = audit(PROJ, { config: null });
  const noisy = findings.filter((f) => /npm (test|run build)|node (build|test)\.js/.test(f.command));
  assert.strictEqual(noisy.length, 0, `flagged routine work: ${noisy.map((f) => f.command).join(', ')}`);
});

test('AUDIT: heredoc bodies are text, not commands', () => {
  const got = extract('release.sh', fs.readFileSync(pathMod.join(PROJ, 'release.sh'), 'utf8'));
  const cmds = got.map((g) => g.command);
  assert.ok(!cmds.some((c) => c.includes('This help text')), 'extracted heredoc prose as a command');
  assert.ok(!cmds.some((c) => c.trim() === 'terraform destroy'), 'extracted a heredoc line as a live command');
});

test('AUDIT: comments and bare assignments are skipped', () => {
  const got = extract('release.sh', fs.readFileSync(pathMod.join(PROJ, 'release.sh'), 'utf8'));
  const cmds = got.map((g) => g.command);
  assert.ok(!cmds.some((c) => c.startsWith('#')), 'extracted a comment');
  assert.ok(!cmds.some((c) => c === 'VERSION="1.2.3"'), 'extracted a bare assignment');
});

test('AUDIT: a YAML block scalar is one command, not one per line', () => {
  const yml = fs.readFileSync(pathMod.join(PROJ, '.github', 'workflows', 'ci.yml'), 'utf8');
  const got = extract('ci.yml', yml);
  const block = got.find((g) => g.command.includes('npm run build'));
  assert.ok(block, 'lost the block scalar entirely');
  assert.ok(block.command.includes('echo'), 'block was split per line, which creates unparseable fragments');
});

test('AUDIT: never reports its own parse failures as project risk', () => {
  // Static extraction produces fragments. A fragment we misread is our bug,
  // not the project's risk, and reporting it teaches people to ignore output.
  const { findings } = audit(PROJ, { config: null });
  assert.ok(!findings.some((f) => /Could not parse/.test(f.reasons.join(' '))),
    'reported an extraction artifact as a finding');
});

// ----------------------------------------------------------------- explain --

const { guidanceFor } = require('../src/rules');

test('EXPLAIN: known commands get specific guidance, not boilerplate', () => {
  const g = guidanceFor('terraform', 'remote');
  assert.ok(g.unrecoverable.includes('snapshot'), 'terraform guidance is generic');
  assert.ok(g.before.length >= 1);
});

test('EXPLAIN: docker names volumes, since that is the part people lose', () => {
  assert.ok(guidanceFor('docker', 'machine').unrecoverable.toLowerCase().includes('volume'));
});

test('EXPLAIN: an unknown command still gets honest guidance', () => {
  const g = guidanceFor('some-unknown-binary', 'remote');
  assert.ok(g.changes && g.unrecoverable && g.before.length);
  // The fallback must not invent a specific consequence it cannot know.
  assert.ok(g.unrecoverable.toLowerCase().includes('unknown'));
});

test('EXPLAIN: guidance scales with reach', () => {
  const local = guidanceFor('unknown-thing', 'local');
  const remote = guidanceFor('unknown-thing', 'remote');
  assert.notStrictEqual(local.changes, remote.changes);
  assert.ok(local.unrecoverable.toLowerCase().includes('uncommitted'));
});

// -------------------------------------------------------------------- hook --

const { decide } = require('../src/hook');

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: process.cwd() });

test('hook stays silent on a safe command', () => {
  assert.strictEqual(decide(bash('npm test')), null);
});

test('hook stays silent on local destructive work', () => {
  assert.strictEqual(decide(bash('rm -rf ./dist')), null, 'prompted for a local delete');
});

test('hook stays silent on machine-level work, which is contained', () => {
  assert.strictEqual(decide(bash('systemctl stop nginx')), null);
});

test('hook asks before a command leaves the machine destructively', () => {
  const out = decide(bash('terraform destroy'));
  assert.ok(out, 'no decision emitted');
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('hook reason explains why undo will not save you', () => {
  const out = decide(bash('git push --force origin main'));
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('rewind'));
});

test('hook ignores non-Bash tools, which checkpointing already covers', () => {
  assert.strictEqual(decide({ tool_name: 'Edit', tool_input: { file_path: 'a.js' } }), null);
});

test('hook tolerates malformed payloads instead of throwing', () => {
  assert.strictEqual(decide({ tool_name: 'Bash' }), null);
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: {} }), null);
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 42 } }), null);
});

// --- other harnesses ---------------------------------------------------

const { decideCursor, decideCodex } = require('../src/hook');

const cursorPayload = (command) => ({ command, cwd: process.cwd(), hook_event_name: 'beforeShellExecution' });

test('CURSOR: allows a safe command explicitly', () => {
  assert.deepStrictEqual(decideCursor(cursorPayload('npm test')), { permission: 'allow' });
});

test('CURSOR: asks on a remote destructive command', () => {
  const out = decideCursor(cursorPayload('git push --force origin main'));
  assert.strictEqual(out.permission, 'ask');
  assert.ok(out.user_message.includes('blastradius'));
  assert.ok(out.agent_message, 'no agent_message, the model gets no guidance');
});

test('CURSOR: reads the flat payload shape, not tool_input', () => {
  // Cursor sends {command}, not {tool_input:{command}}. Getting this wrong
  // means the hook silently never fires, which is the worst failure mode.
  assert.strictEqual(decideCursor({ tool_input: { command: 'terraform destroy' } }), null);
});

test('CODEX: stays silent on a safe command', () => {
  assert.strictEqual(decideCodex(bash('npm test')), null);
});

test('CODEX: denies rather than asks, because ask is unsupported there', () => {
  const out = decideCodex(bash('git push --force origin main'));
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('CODEX: the deny reason is never empty', () => {
  // Codex treats an empty reason as a failed hook and runs the command
  // anyway, so this is a correctness requirement, not a nicety.
  const out = decideCodex(bash('terraform destroy'));
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.trim().length > 20);
});

test('CODEX: says plainly that it blocked rather than prompted', () => {
  const out = decideCodex(bash('terraform destroy'));
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('cannot prompt'));
});

test('hook escalates a command it cannot parse', () => {
  const out = decide(bash('rm -rf "/etc'));
  assert.ok(out, 'unparseable command was silently allowed');
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'ask');
});

// ------------------------------------------------------------------ report --

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failures.length) {
  failures.forEach((f) => console.error(`  FAIL  ${f}\n`));
  process.exit(1);
}
