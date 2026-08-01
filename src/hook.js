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
async function runHook() {
  let payload = null;
  try {
    payload = await readPayload();
    if (!payload) return 0;

    const output = decide(payload);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (err) {
    process.stderr.write(`blastradius: internal error, allowing command (${err.message})\n`);
  }
  return 0;
}

module.exports = { decide, runHook, readPayload, SEVERITY_TO_DECISION };
