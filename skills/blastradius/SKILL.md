---
name: blastradius
description: Use when about to run, or when asked to review, a shell command that could reach beyond the current project - ssh, terraform, kubectl, helm, docker volume removal, cloud CLIs, database clients pointed at a remote host, force-push, systemd service changes, package removal, or any rm outside the working directory. Also use when the user asks what a command will affect, whether something is safe to run, how to guard an agent against destructive commands, or wants to turn written project rules like "never touch X" into enforcement.
---

# blastradius

Work out how far a command reaches before it runs.

## Why this exists

Agent checkpointing covers file edits. Anthropic's own documentation is explicit:

> Bash command changes not tracked. Checkpointing does not track files
> modified by bash commands.

So `/rewind` covers `Edit` and `Write`, and covers nothing done through the
shell. That is where `ssh`, `terraform`, `kubectl`, `docker compose down -v`,
and `git push --force` live. Those are the commands that cost people
production databases, and no undo reaches them.

## How to use it

Classify a single command:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/blastradius.js" check "<command>"
```

Exit code 0 means ok or notice. Exit code 2 means it needs a human decision.

Show what the environment currently points at:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/blastradius.js" context
```

## The model, in two axes

Reach:

| Level | Meaning |
|---|---|
| `local` | only the working directory, an editor can undo it |
| `machine` | this box, outside the project |
| `remote` | another host, cluster, or cloud account |

Destructive: whether it removes or overwrites state.

**Only the intersection is worth interrupting for.** `kubectl get pods` is
remote and harmless. `rm -rf ./build` is destructive and local. Neither
deserves a prompt. `terraform destroy` is both, and it does.

Apply the same discipline in your own judgement. Do not warn a user about
`rm -rf ./dist`. Do warn them before something leaves the machine.

## Reading a verdict

`DANGER` means the target's name looks like production, taken from the active
cluster context, terraform workspace, or AWS profile. Say which one and quote
the name. Never paraphrase a danger verdict into something softer.

## Turning written rules into enforcement

Most projects already have a list of things nobody should do, sitting in a
CLAUDE.md or a runbook as prose. "Never touch the Arc One process." "Do not
restart a populated server without a countdown." Those rules only work while
someone remembers them.

A `.blastradius.json` in the project root turns them into checks:

```json
{
  "rules": [
    {
      "id": "live-game-servers",
      "when": { "pattern": "\\bmc-[a-z]+" },
      "severity": "danger",
      "why": "Live server with players connected. Send a countdown first."
    }
  ]
}
```

`when` takes `command` (a resolved command name, after sudo and env are
unwrapped) or `pattern` (a case-insensitive regex). `severity` is `notice`,
`confirm`, or `danger`. `why` is required and is shown to a human, so write it
for one.

When helping someone write a config, read what the repo already says about
itself: CLAUDE.md, `.claude/rules/*.md`, deploy scripts, systemd units,
compose files, Terraform. The rules are usually already written down.

**Never put infrastructure detail in a config that gets committed.** Host
names, IP addresses, key paths, and account identifiers belong in the file
listed in `.gitignore`, not in a public repository.

## Constraints worth knowing

- Custom rules can only escalate. There is no allowlist, by design: the agent
  being guarded can write files, so a config that could weaken the guard would
  be the first thing worth attacking. Silencing a false positive is a pull
  request against `src/rules.js`, reviewed by a human.
- The guard asks, it never blocks.
- It fails open. If it errors, the command proceeds. It is a seatbelt, not a
  cage, and it must never be the reason someone cannot fix an outage.
