# Security

blastradius is a safety control, so the honest place to start is with what it
does **not** protect you from.

## Threat model

**What it is.** A classifier that inspects a shell command string before an
agent runs it, and asks a human when that command would change state beyond
the local machine.

**What it is not.** It is not a sandbox, not a permission system, and not a
recovery tool. It cannot stop a command, only ask. It cannot undo anything.
Once `terraform destroy` returns, nothing in this repository helps you.

### It will not save you from

- **A determined attacker.** This reads a command string. Anything that runs
  code without a recognizable command string, or that reaches the shell by a
  path the harness does not send through a `PreToolUse` hook, is invisible to
  it.
- **Commands it has no rule for.** The rule table is finite and opinionated.
  An unknown binary that wraps `kubectl` is not classified.
- **Opaque wrapper scripts.** `./deploy.sh` could do anything. String-level
  classification cannot see inside it. Write a project rule if you have one
  that matters.
- **Anything already running.** It is a pre-execution check only.

It is a seatbelt, not a cage. Its value is that the expensive mistakes in this
space are mostly ordinary commands run in the wrong place, not clever attacks.

## Design decisions that are security decisions

**Custom rules can only escalate.** There is no allowlist, no severity
downgrade, and no off switch in config. The agent this tool guards has
file-write access, so a config that could weaken the guard would be the first
thing worth attacking. A safety control its own subject can edit is not a
safety control.

**It fails open.** If the tool throws, or receives input it does not
understand, your command proceeds under the normal permission flow. This is
deliberate. A safety tool that can wedge your agent because of its own bug is
a worse problem than the one it solves, and a tool people disable protects
nobody.

**It never executes anything to decide.** All context (cluster, workspace,
cloud profile, docker host) comes from reading local files and environment
variables. A guard that runs commands in order to judge a command is its own
attack surface.

**No network, no telemetry, no dependencies.** It makes no outbound
connections and collects nothing. The dependency count is zero at runtime and
at test time, so the supply chain is this repository and Node itself.

## Reporting a vulnerability

The most valuable report is a **bypass**: a command that is genuinely
destructive and remote, that the classifier rates `ok` or `notice`.

Open a [private security advisory](https://github.com/coreyhiggins/blastradius/security/advisories/new).
If you would rather email, use corey@wynfall.dev.

Please include the exact command string and the verdict you got from
`blastradius check "<command>"`. That is usually enough to reproduce it.

For a bypass, a public issue is also acceptable and often more useful, since
the failure mode is "this tool is less protective than you thought" rather
than "this tool can be used to attack you". Use your judgement, and use the
private channel if you are unsure.

Expect a response within a few days. This is maintained by one person.

## Scope

In scope: bypasses, misclassifications that hide real risk, a config file
that manages to weaken the guard, and anything that lets the tool itself be
used to run code.

Out of scope: false positives (open a normal issue, they are still bugs worth
fixing), and the inherent limits listed in the threat model above.
