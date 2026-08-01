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
