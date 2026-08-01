'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { expand, basename } = require('./parse');
const {
  RULES, LOCAL, MACHINE, REMOTE, RADIUS_ORDER, remainderAfterHost,
} = require('./rules');
const { loadConfig, applyCustomRules } = require('./config');

// Names that, when they show up as a kube context, an aws profile, a
// terraform workspace, or an ssh host, mean a human should look before the
// agent proceeds. Deliberately broad: a false prompt costs two seconds, a
// missed one cost somebody 2.5 years of records.
const PROD_PATTERN = /(^|[-_./])(prod|production|prd|live|master|main|primary)([-_./]|$)/i;

function resolve(value, argv, cmd, meta) {
  return typeof value === 'function' ? value(argv, cmd, meta) : value;
}

/**
 * Read the environment the command will actually run against, so a call can
 * be judged on where it points rather than only on what it types.
 *
 * Every lookup here is a cheap local file or env read. Nothing shells out,
 * because a guard that runs commands to decide whether to allow a command
 * is its own problem.
 */
function readContext(cwd = process.cwd()) {
  const ctx = {};

  // Active kubernetes context.
  try {
    const kubeconfig = process.env.KUBECONFIG || path.join(os.homedir(), '.kube', 'config');
    const text = fs.readFileSync(kubeconfig, 'utf8');
    const match = text.match(/^current-context:\s*"?([^"\n\r]+)"?/m);
    if (match) ctx.kubeContext = match[1].trim();
  } catch { /* no kubeconfig is the common case, not an error */ }

  // Active terraform workspace.
  try {
    const ws = fs.readFileSync(path.join(cwd, '.terraform', 'environment'), 'utf8').trim();
    if (ws) ctx.terraformWorkspace = ws;
  } catch { /* not a terraform project */ }

  if (process.env.AWS_PROFILE) ctx.awsProfile = process.env.AWS_PROFILE;
  if (process.env.DOCKER_HOST) ctx.dockerHost = process.env.DOCKER_HOST;

  return ctx;
}

/** Which recorded context, if any, applies to this command. */
function contextFor(cmd, ctx) {
  if (['kubectl', 'oc', 'helm'].includes(cmd) && ctx.kubeContext) {
    return { label: 'cluster', value: ctx.kubeContext };
  }
  if (['terraform', 'tofu'].includes(cmd) && ctx.terraformWorkspace) {
    return { label: 'workspace', value: ctx.terraformWorkspace };
  }
  if (cmd === 'aws' && ctx.awsProfile) {
    return { label: 'profile', value: ctx.awsProfile };
  }
  if (['docker', 'podman'].includes(cmd) && ctx.dockerHost) {
    return { label: 'docker host', value: ctx.dockerHost };
  }
  return null;
}

function findRule(cmd) {
  return RULES.find((rule) => rule.match.includes(cmd));
}

/** Classify a single argv. Returns a finding, or null when unremarkable. */
function classifyArgv(argv, ctx, depth = 0, meta = {}) {
  if (!argv.length) return null;

  const cmd = basename(argv[0]);
  const rule = findRule(cmd);
  if (!rule) return null;

  const radius = resolve(rule.radius, argv, cmd, meta) || LOCAL;
  const destructive = Boolean(resolve(rule.destructive, argv, cmd, meta));
  const why = resolve(rule.why, argv, cmd, meta);

  const finding = {
    command: cmd,
    argv,
    radius,
    destructive,
    why,
    context: contextFor(cmd, ctx),
    nested: [],
  };

  // Something the command will cause to run elsewhere, most obviously an
  // ssh payload. Judge that on its own merits too: `ssh web01 "rm -rf /"`
  // is not an ssh problem, it is an rm problem that happens to be remote.
  if (rule.payload && depth < 3) {
    const payload = rule.payload(argv, cmd);
    if (payload) {
      const inner = classifyLine(payload, ctx, depth + 1);
      finding.nested = inner.findings;
      // A destructive payload makes the carrier destructive.
      if (inner.findings.some((f) => f.destructive)) finding.destructive = true;
    }
  }

  return finding;
}

/** Classify a whole command line, including compound and substituted parts. */
function classifyLine(line, ctx = readContext(), depth = 0) {
  const { commands, unbalanced } = expand(line);
  const findings = [];

  for (const { argv, pipedInto } of commands) {
    const finding = classifyArgv(argv, ctx, depth, { pipedInto });
    if (finding) findings.push(finding);
  }

  return { findings, unbalanced };
}

/**
 * The top-level verdict for one command line.
 *
 * `severity` is what a caller should act on:
 *   ok       nothing worth interrupting for
 *   notice   destructive, but contained to this machine
 *   confirm  leaves this machine and changes state
 *   danger   leaves this machine, is destructive, and points at something
 *            whose name looks like production
 */
function assess(line, options = {}) {
  const cwd = options.cwd || process.cwd();
  const ctx = options.context || readContext(cwd);
  const { findings, unbalanced } = classifyLine(line, ctx);

  // `config: null` disables custom rules entirely, which the tests rely on
  // so a stray .blastradius.json on a dev machine cannot change results.
  const config = options.config === undefined ? loadConfig(cwd) : options.config;

  const flat = [];
  const walk = (list) => list.forEach((f) => { flat.push(f); walk(f.nested); });
  walk(findings);

  const finish = (result) => applyCustomRules(line, flat, result, config);

  // A line we could not parse is not a line we can vouch for. Say so rather
  // than returning a confident "ok" that happens to be wrong.
  if (unbalanced) {
    return finish({
      severity: 'confirm',
      radius: REMOTE,
      reasons: ['Could not parse this command safely (unbalanced quotes), so its effects are unknown.'],
      findings: flat,
      unparseable: true,
    });
  }

  // Reported reach is the furthest ANY command travels, not just the
  // destructive ones. `kubectl get pods` is harmless but it is plainly not
  // local, and saying otherwise would teach the user to distrust the label.
  const reach = flat.reduce(
    (acc, f) => (RADIUS_ORDER[f.radius] > RADIUS_ORDER[acc] ? f.radius : acc),
    LOCAL
  );

  const destructive = flat.filter((f) => f.destructive);
  if (!destructive.length) {
    return finish({ severity: 'ok', radius: reach, reasons: [], findings: flat, unparseable: false });
  }

  const worst = destructive.reduce(
    (acc, f) => (RADIUS_ORDER[f.radius] > RADIUS_ORDER[acc.radius] ? f : acc),
    destructive[0]
  );

  const prodHits = destructive.filter((f) => f.context && PROD_PATTERN.test(f.context.value));

  let severity;
  if (worst.radius === LOCAL) severity = 'ok';
  else if (worst.radius === MACHINE) severity = 'notice';
  else severity = prodHits.length ? 'danger' : 'confirm';

  const reasons = destructive.map((f) => {
    const target = f.context ? ` [${f.context.label}: ${f.context.value}]` : '';
    return `${f.argv.slice(0, 4).join(' ')}${target} - ${f.why}`;
  });

  if (prodHits.length) {
    const names = [...new Set(prodHits.map((f) => `${f.context.label} "${f.context.value}"`))];
    reasons.unshift(`Target looks like production: ${names.join(', ')}.`);
  }

  return finish({ severity, radius: worst.radius, reasons, findings: flat, unparseable: false });
}

module.exports = { assess, classifyLine, readContext, PROD_PATTERN };
