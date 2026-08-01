<div align="center">

# blastradius

**How far does this command reach?**

[![CI](https://github.com/coreyhiggins/blastradius/actions/workflows/ci.yml/badge.svg)](https://github.com/coreyhiggins/blastradius/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@coreyhiggins/blastradius)](https://www.npmjs.com/package/@coreyhiggins/blastradius)
[![tests](https://img.shields.io/badge/tests-81%20passing-brightgreen)](test/run-tests.js)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Your AI agent can undo the files it edits. It cannot undo `terraform destroy`.

</div>

```
$ blastradius check "terraform destroy -auto-approve"

  confirm terraform destroy -auto-approve
  reach: remote

  - terraform destroy -auto-approve - destroys every resource in the targeted state
```

---

## Not sure whether you need this?

You need it if your AI assistant can run terminal commands. That is most of
them now, out of the box.

The part people find surprising: when your agent **edits a file**, you can
undo it. When your agent **runs a terminal command**, you cannot. Claude Code
says so in its own documentation:

> Checkpointing does not track files modified by bash commands.

So the undo button covers the safe half, and stops exactly where the expensive
half begins. Deleting a server, wiping a database, pushing something to real
users: all terminal commands, none of them undoable.

blastradius sits in front of those and asks you first. It says nothing during
ordinary work.

**One line to install:**

```bash
npx @coreyhiggins/blastradius install
```

You will not hear from it while you build, test, or commit. You will hear from
it the moment something is about to reach past your own computer.

<details>
<summary><b>What it looks like when it does speak up</b></summary>

```
  DANGER  kubectl delete ns payments
  reach: remote

  - Target looks like production: cluster "gke_acme_us-east1_production".
  - kubectl delete ns [cluster: gke_acme_us-east1_production] - delete against the active cluster context
```

It read your active cluster name to work that out. The same command pointed at
a local test cluster is a quiet `confirm` instead.

</details>

---

## Why this exists

Claude Code's checkpointing documentation says it plainly:

> **Bash command changes not tracked.** Checkpointing does not track files modified by bash commands... These file modifications cannot be undone through rewind. Only direct file edits made through Claude's file editing tools are tracked.

So `/rewind` covers `Edit` and `Write`. It covers nothing your agent does through the shell, which is where `ssh`, `terraform`, `kubectl`, `docker compose down -v`, and `git push --force` live.

That gap is not theoretical. An agent given AWS credentials and a stale Terraform state ran `terraform destroy` and took out a production database and its snapshots: [2.5 years of records](https://news.ycombinator.com/item?id=47278720). Another found an API token with volume-delete scope in what the developer believed was staging and [deleted the production volume](https://news.ycombinator.com/item?id=47911524).

In both cases the source files were fine. That was never the problem.

## What it does

Every command gets classified on two independent axes, because conflating them is what makes guardrails annoying enough to uninstall.

**Reach** - how far the damage travels:

| | |
|---|---|
| `local` | Only the working directory. Your editor can undo it. |
| `machine` | This box, outside the project. Restore or reinstall. |
| `remote` | Another host, cluster, or cloud account. Someone else feels it. |

**Destructive** - whether it removes or overwrites state.

Only the intersection is worth interrupting a human for:

```
kubectl get pods          ok       remote, harmless
rm -rf ./build            ok       destructive, local
docker compose down       ok       remote-ish, reversible
rm -rf /var/lib/mysql     notice   destructive, this machine
git push --force          confirm  destructive, leaves the machine
terraform destroy         confirm  destructive, leaves the machine
```

It reads the environment your command actually points at. `kubectl delete` against `kind-local` is a `confirm`. The same command against `gke_acme_us-east1_production` is a `DANGER`, and it says why:

```
  DANGER  kubectl delete ns payments
  reach: remote

  - Target looks like production: cluster "gke_acme_us-east1_production".
  - kubectl delete ns [cluster: gke_acme_us-east1_production] - delete against the active cluster context
```

Context comes from your kubeconfig's `current-context`, your Terraform workspace, `AWS_PROFILE`, and `DOCKER_HOST`. All cheap local reads. Nothing shells out, because a guard that runs commands to decide whether to allow a command is its own problem.

## Install

Pick your agent. Each prints a config snippet to paste.

```bash
npx @coreyhiggins/blastradius install              # Claude Code
npx @coreyhiggins/blastradius install cursor       # Cursor
npx @coreyhiggins/blastradius install codex        # Codex CLI
```

Claude Code users can install it as a plugin instead, which also adds a
`/blastradius` command:

```
/plugin marketplace add coreyhiggins/blastradius
/plugin install blastradius
```

### What each agent can actually do

Harnesses do not offer the same controls, and the difference matters.

| Agent | Hook | Can it ask you? |
|---|---|---|
| Claude Code | `PreToolUse` | Yes |
| Cursor | `beforeShellExecution` | Yes |
| Codex CLI | `PreToolUse` | **No. It blocks instead.** |

**Codex is the exception worth reading.** Its hook contract explicitly
rejects "ask" and treats it as a failed hook, which means the command runs
anyway. Only an outright block does anything there. So on Codex, blastradius
**denies** instead of prompting, and tells you to re-run the command yourself
if you meant it.

That is a real departure from this tool's usual rule of asking rather than
blocking, and it is not a choice we get to make. A blocked command you can
re-run beats a database you cannot get back.

Codex also needs hooks turned on, since they are off by default:

```toml
# ~/.codex/config.toml
[features]
hooks = true
```

## Examples

[**examples/**](examples/) has four worked walkthroughs, from trying it in 30 seconds
with no install through to enforcing team rules in CI, plus three ready-made
configs you can copy: a game server, a web deploy on a shared VPS, and a data
team. All three are verified in CI against real commands.

## Your own rules

The built-in table knows `systemctl restart` is routine. It cannot know that
`mc-cobblemon` is a game server with forty people connected to it right now.
That is what a `.blastradius.json` in your project root is for:

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

`when` takes `command` (matched against the resolved command name, after
`sudo` and `env` are unwrapped) or `pattern` (a case-insensitive regex).
`severity` is `notice`, `confirm`, or `danger`. `why` is required, and it is
shown to a human, so write it for one.

Most projects already have these rules written down somewhere as prose. A
CLAUDE.md that says "never touch X" or a runbook that says "do not restart Y
without a countdown" is a rule that only works while somebody remembers it.
This is how it becomes a check.

**Two things that are easy to get wrong.**

*`notice` never interrupts.* It appears in `blastradius check` and nowhere
else. That is right for the built-ins, where `rm -rf /var/log` should be
recorded without nagging you. It is usually wrong for a rule you wrote
yourself: if it was worth writing, it is worth seeing. Use `confirm`.

*Gate patterns on a verb, not a bare name.* `"pattern": "servers/prod"`
matches `tail`, `ls`, and `sha256sum` as readily as `rm`. Reading is not
changing. Write `"(rm|mv|cp|chown|systemctl\\s+restart)\\b.{0,40}servers/prod"`
instead. An audit of 166 real commands found every false positive traced to a
pattern matching a bare substring, including one that flagged a runbook's own
documented safe-to-restart check as `danger`. That is the noise that gets a
guard uninstalled.

**Put nothing secret in a committed config.** Host names, IPs, key paths, and
account identifiers belong in a gitignored file.

### Custom rules can only escalate

There is no allowlist. You cannot use config to silence a rule, lower a
severity, or turn the guard off.

That is deliberate, and it is the point. The agent this tool guards **has
file-write access**. If a config file could weaken the guard, then writing
`.blastradius.json` is the first bypass anyone would find, and a safety
control its own subject can edit is not a safety control.

The cost is real: you cannot currently silence a false positive with config.
That belongs in [`src/rules.js`](src/rules.js) as a pull request, where a
human reviews it. Given the alternative, it is the right trade.

## Design rules

**It stays quiet.** Safe commands produce no output and no decision, so the normal permission flow runs untouched. A guard that comments on everything gets uninstalled in a day, and an uninstalled guard protects nobody. Local destructive work (`rm -rf ./dist`) never prompts either.

**It fails open.** If this tool throws or gets input it does not understand, your command proceeds. A safety tool that can wedge your agent because of its own bug is worse than the problem it solves.

**It asks, it does not block.** `permissionDecision: "ask"` surfaces the reach and hands you the decision. You know things it does not.

**It cannot be talked around.** The parser respects quoting and escapes, unwraps `sudo -u deploy`, follows `$(...)` and backticks, and inspects what you send through `ssh`:

```
$ blastradius check "ssh deploy@web01 'rm -rf /var/www'"

  confirm ssh deploy@web01 'rm -rf /var/www'
  reach: remote

  - ssh deploy@web01 rm -rf /var/www - runs on, or copies to, another machine
  - rm -rf /var/www - recursively deletes a path outside the project directory
```

A command it cannot parse is escalated, never waved through. Of the 81 tests, 10 are bypass attempts, 6 prove config cannot weaken the guard, and 2 prove a wrapper script cannot read outside the project, because a guard you can slip past by putting quotes in the right place is worse than no guard: it reads as protection while providing none.

## Usage

```bash
blastradius check "<command>"   # classify a command, exit 2 if it needs confirming
blastradius context             # show the cluster, workspace, and profile in play
blastradius hook                # PreToolUse hook, reads JSON on stdin
blastradius install             # print the settings snippet
```

## What it is not

Not a sandbox. Not a recovery tool. It cannot undo anything, and nothing else can either once `terraform destroy` returns.

It pairs with [cc-safety-net](https://github.com/kenryu42/cc-safety-net), which guards local filesystem and git operations and states that it has no network layer. This is the network layer.

## Disagreeing with a call

Every rule lives in [`src/rules.js`](src/rules.js) as data, not code. If a call is wrong for your setup, that is one row to edit and a pull request worth opening. Rules that generate false prompts are bugs, and the tests treat them that way.

## Requirements

Node 18+. No dependencies, at runtime or at test time. `node test/run-tests.js` works on a clean checkout with nothing installed.

## License

MIT
