# blastradius

How far does this command reach?

Your AI agent can undo the files it edits. It cannot undo `terraform destroy`.

```
npx @coreyhiggins/blastradius install
```

Works with Claude Code, Cursor, and Codex CLI. Codex cannot ask, so it blocks instead. A blocked command you can re-run beats a database you cannot get back.

```
npx @coreyhiggins/blastradius install              # Claude Code
npx @coreyhiggins/blastradius install cursor       # Cursor
npx @coreyhiggins/blastradius install codex        # Codex CLI
```

Claude Code plugin:

```
/plugin marketplace add coreyhiggins/blastradius
/plugin install blastradius
```

Codex needs hooks on:

```toml
# ~/.codex/config.toml
[features]
hooks = true
```

## What it does

Every command is classified on two axes: how far the damage travels, and whether it destroys state. Only the intersection is worth interrupting you for.

```
kubectl get pods          ok       remote, harmless
rm -rf ./build            ok       destructive, local
git push --force          confirm  leaves the machine
terraform destroy         confirm  leaves the machine
```

It reads the environment the command actually points at. `kubectl delete` against `kind-local` is a confirm. The same command against a cluster named production is DANGER, and it says why. Context comes from kubeconfig, Terraform workspace, `AWS_PROFILE`, and `DOCKER_HOST`. Nothing shells out to decide that.

Custom rules can only escalate. The agent this guards can write files, so a config that could weaken the guard is not a guard.

## Audit

The hook is reactive. `audit` is the other direction: it reads scripts, CI, and Makefiles already in the repo and names the commands an agent could run without thinking.

```
npx @coreyhiggins/blastradius audit
```

Exit 2 if anything is flagged.

## Usage

```
blastradius check "<command>"
blastradius explain "<command>"
blastradius audit
blastradius install
```

Not a sandbox. Not a recovery tool. Node 18+, zero dependencies. `node test/run-tests.js` on a clean checkout.

MIT