'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SEVERITY_ORDER = { ok: 0, notice: 1, confirm: 2, danger: 3 };
const VALID_SEVERITIES = Object.keys(SEVERITY_ORDER).filter((s) => s !== 'ok');

// Guardrails on the config itself. A rules file is data, but it is data that
// gets compiled into regular expressions and evaluated against every command,
// so it needs limits.
const MAX_RULES = 200;
const MAX_PATTERN_LENGTH = 500;

const CONFIG_NAME = '.blastradius.json';

/**
 * THE SECURITY PROPERTY OF THIS FILE, stated once, plainly:
 *
 *   Custom rules can only ESCALATE. They can never lower a severity,
 *   allowlist a command, or turn the guard off.
 *
 * This is not a limitation, it is the whole design. The agent this tool
 * guards against has file-write access. If a config file could downgrade or
 * silence a rule, then the first thing a misbehaving or prompt-injected
 * agent would do is write `.blastradius.json` and walk straight through the
 * guard. A safety control that its subject can edit is not a safety control.
 *
 * The cost is real and worth naming: you cannot currently silence a false
 * positive with config. Silencing belongs in the rule table, as a pull
 * request, where a human reviews it. That is the trade.
 */

function severityRank(s) {
  return SEVERITY_ORDER[s] ?? -1;
}

/** Validate one rule. Returns { rule } or { error }. */
function normalizeRule(raw, index) {
  const where = `rule[${index}]${raw && raw.id ? ` (${raw.id})` : ''}`;

  if (!raw || typeof raw !== 'object') return { error: `${where}: not an object` };
  if (!raw.id || typeof raw.id !== 'string') return { error: `${where}: missing string "id"` };

  const when = raw.when || {};
  if (typeof when !== 'object') return { error: `${where}: "when" must be an object` };

  const hasCommand = typeof when.command === 'string' && when.command.length > 0;
  const hasPattern = typeof when.pattern === 'string' && when.pattern.length > 0;
  if (!hasCommand && !hasPattern) {
    return { error: `${where}: "when" needs a "command" or a "pattern"` };
  }

  let regex = null;
  if (hasPattern) {
    if (when.pattern.length > MAX_PATTERN_LENGTH) {
      return { error: `${where}: pattern longer than ${MAX_PATTERN_LENGTH} characters` };
    }
    try {
      regex = new RegExp(when.pattern, 'i');
    } catch (err) {
      return { error: `${where}: invalid pattern (${err.message})` };
    }
  }

  if (!VALID_SEVERITIES.includes(raw.severity)) {
    return { error: `${where}: "severity" must be one of ${VALID_SEVERITIES.join(', ')}` };
  }

  if (!raw.why || typeof raw.why !== 'string') {
    return { error: `${where}: missing string "why" explaining the risk to a human` };
  }

  return {
    rule: {
      id: raw.id,
      command: hasCommand ? when.command.toLowerCase() : null,
      regex,
      severity: raw.severity,
      why: raw.why,
    },
  };
}

/** Parse one config file's contents. Never throws. */
function parseConfig(text, source) {
  const rules = [];
  const errors = [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { rules, errors: [`${source}: not valid JSON (${err.message})`] };
  }

  const list = Array.isArray(parsed.rules) ? parsed.rules : [];
  if (!Array.isArray(parsed.rules)) {
    errors.push(`${source}: expected a "rules" array`);
  }

  if (list.length > MAX_RULES) {
    errors.push(`${source}: more than ${MAX_RULES} rules, ignoring the excess`);
  }

  list.slice(0, MAX_RULES).forEach((raw, i) => {
    const { rule, error } = normalizeRule(raw, i);
    if (error) errors.push(`${source}: ${error}`);
    else rules.push({ ...rule, source });
  });

  return { rules, errors };
}

/**
 * Load rules from the project config and the user's home config.
 *
 * Both apply. Neither can weaken the other, because nothing here can weaken
 * anything: every custom rule is an escalation.
 *
 * A broken config produces warnings and is otherwise ignored. It never
 * crashes the guard and it never causes a command to be allowed that would
 * otherwise have been flagged, because the built-in rules run regardless.
 */
function loadConfig(cwd = process.cwd(), { homeDir = os.homedir() } = {}) {
  const rules = [];
  const errors = [];
  const sources = [];

  const candidates = [
    path.join(cwd, CONFIG_NAME),
    path.join(homeDir, CONFIG_NAME),
  ];

  for (const file of candidates) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // absent is the normal case
    }
    const parsedFile = parseConfig(text, file);
    rules.push(...parsedFile.rules);
    errors.push(...parsedFile.errors);
    sources.push(file);
  }

  return { rules, errors, sources };
}

/**
 * Apply custom rules to an already-computed verdict.
 *
 * `findings` are the built-in classifier's findings, used so a custom rule
 * can match on a resolved command name after sudo/env unwrapping rather than
 * on raw text a wrapper could disguise.
 */
function applyCustomRules(commandLine, findings, baseResult, config) {
  if (!config || !config.rules.length) return baseResult;

  const matched = [];

  for (const rule of config.rules) {
    let hit = false;

    if (rule.command) {
      hit = findings.some((f) => f.command === rule.command);
    }
    if (!hit && rule.regex) {
      // Test the whole line AND each unwrapped argv, so `sudo -u deploy
      // systemctl restart mc-cobblemon` matches a rule written against
      // `systemctl restart mc-`.
      hit = rule.regex.test(commandLine)
        || findings.some((f) => rule.regex.test(f.argv.join(' ')));
    }

    if (hit) matched.push(rule);
  }

  if (!matched.length) return baseResult;

  const highest = matched.reduce(
    (acc, r) => (severityRank(r.severity) > severityRank(acc.severity) ? r : acc),
    matched[0]
  );

  // Escalate only. If the built-in verdict is already at least as severe,
  // keep it and just add the explanation.
  const severity = severityRank(highest.severity) > severityRank(baseResult.severity)
    ? highest.severity
    : baseResult.severity;

  const reasons = [
    ...matched.map((r) => `[${r.id}] ${r.why}`),
    ...baseResult.reasons,
  ];

  return { ...baseResult, severity, reasons, customRules: matched.map((r) => r.id) };
}

module.exports = {
  loadConfig,
  parseConfig,
  applyCustomRules,
  normalizeRule,
  severityRank,
  CONFIG_NAME,
  MAX_RULES,
  MAX_PATTERN_LENGTH,
  VALID_SEVERITIES,
};
