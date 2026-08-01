# blastradius

**How far does this command reach?**

Your coding agent's undo covers files. It does not cover `terraform destroy`.

```
$ blastradius check "terraform destroy -auto-approve"

  confirm terraform destroy -auto-approve
  reach: remote

  - terraform destroy -auto-approve - destroys every resource in the targeted state
```

Zero dependencies. One file of rules you can read in five minutes and disagree with.

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

```bash
npx blastradius install
```

That prints the snippet for `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "npx -y blastradius hook" }]
      }
    ]
  }
}
```

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

A command it cannot parse is escalated, never waved through. Of the 49 tests, 10 are bypass attempts, because a guard you can slip past by putting quotes in the right place is worse than no guard: it reads as protection while providing none.

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
