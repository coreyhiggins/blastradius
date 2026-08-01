'use strict';

const { assess } = require('./classify');

// Claude Code PreToolUse hook protocol. Verified against
// code.claude.com/docs/en/hooks.
//
// The single most important behaviour here is what happens on a SAFE
// command: nothing. We emit `defer` and let the normal permission flow
// run. A guard that comments on every command gets uninstalled in a day,
// and an uninstalled guard protects nobody.

const SEVERITY_TO_DECISION = {
  ok: 'defer',
  notice: 'defer',   // destructive but contained to this machine
  confirm: 'ask',    // leaves this machine and changes state
  danger: 'ask',     // ...and points at something named like production
};

function decide(payload, options = {}) {
  // Only Bash reaches outside the workspace. Edit and Write are already
  // covered by the harness's own checkpointing.
  if (payload.tool_name !== 'Bash') return null;

  const command = payload.tool_input && payload.tool_input.command;
  if (!command || typeof command !== 'string') return null;

  const result = assess(command, { cwd: payload.cwd || process.cwd(), ...options });
  const decision = SEVERITY_TO_DECISION[result.severity] || 'defer';

  if (decision === 'defer') return null;

  const header = result.severity === 'danger'
    ? 'This command reaches production infrastructure.'
    : 'This command changes state beyond this machine.';

  const reason = [
    `blastradius: ${header}`,
    ...result.reasons.map((r) => `  - ${r}`),
    '',
    'Nothing your editor or /rewind can undo covers this.',
  ].join('\n');

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Cursor: `beforeShellExecution`.
 *
 * The closest match to Claude Code of the three. Its payload is flat
 * ({command, cwd}) rather than nested, and its response genuinely supports
 * "ask", so the tool behaves exactly as designed here.
 */
function decideCursor(payload, options = {}) {
  const command = payload && payload.command;
  if (!command || typeof command !== 'string') return null;

  const result = assess(command, { cwd: payload.cwd || process.cwd(), ...options });
  if (!['confirm', 'danger'].includes(result.severity)) {
    return { permission: 'allow' };
  }

  return {
    permission: 'ask',
    user_message: reasonText(result),
    agent_message: 'This command changes state beyond the local machine. Wait for the user to decide.',
  };
}

/**
 * Codex: `PreToolUse`.
 *
 * Codex accepts the same payload shape as Claude Code but NOT the same
 * responses: it explicitly rejects `permissionDecision: "ask"` and fails
 * open, so the command would run anyway.
 *
 * That leaves one honest choice. Denying is a real departure from this
 * tool's "ask, never block" rule, and it is documented loudly, but the
 * alternative on Codex is no protection at all. A blocked command you can
 * re-run yourself beats a database you cannot get back.
 */
function decideCodex(payload, options = {}) {
  if (payload.tool_name !== 'Bash') return null;

  const command = payload.tool_input && payload.tool_input.command;
  if (!command || typeof command !== 'string') return null;

  const result = assess(command, { cwd: payload.cwd || process.cwd(), ...options });
  if (!['confirm', 'danger'].includes(result.severity)) return null;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      // Codex treats an empty reason as a failed hook and proceeds anyway,
      // so this string is load-bearing, not decorative.
      permissionDecisionReason: `${reasonText(result)}\n\nCodex hooks cannot prompt, only block. Run it yourself if you meant it.`,
    },
  };
}

/** The human-facing explanation, shared by every harness. */
function reasonText(result) {
  const header = result.severity === 'danger'
    ? 'This command reaches production infrastructure.'
    : 'This command changes state beyond this machine.';

  return [
    `blastradius: ${header}`,
    ...result.reasons.map((r) => `  - ${r}`),
    '',
    'Nothing your editor or /rewind can undo covers this.',
  ].join('\n');
}

/** Read the hook payload from stdin. Resolves to null on malformed input. */
function readPayload(stream = process.stdin) {
  return new Promise((resolve) => {
    let raw = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { raw += chunk; });
    stream.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    stream.on('error', () => resolve(null));
  });
}

/**
 * Hook entry point.
 *
 * Fails OPEN by design. If this tool throws, or gets input it does not
 * understand, the user's command proceeds under the normal permission
 * flow. A safety tool that can wedge someone's agent because of its own
 * bug is a worse problem than the one it solves.
 */
const DECIDERS = {
  'claude-code': decide,
  cursor: decideCursor,
  codex: decideCodex,
};

async function runHook(harness = 'claude-code') {
  try {
    const payload = await readPayload();
    if (!payload) return 0;

    const decider = DECIDERS[harness] || decide;
    const output = decider(payload);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (err) {
    process.stderr.write(`blastradius: internal error, allowing command (${err.message})\n`);
  }
  return 0;
}

module.exports = {
  decide, decideCursor, decideCodex, reasonText,
  runHook, readPayload, SEVERITY_TO_DECISION, DECIDERS,
};
