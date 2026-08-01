# Examples

Four ways people actually use this, from "I just want to try it" to "I want it
enforcing my team's rules".

| | |
|---|---|
| [1. Try it without installing anything](#1-try-it-without-installing-anything) | 30 seconds |
| [2. Wire it into your agent](#2-wire-it-into-your-agent) | 2 minutes |
| [3. Teach it your project's rules](#3-teach-it-your-projects-rules) | 10 minutes |
| [4. Use it in CI or a git hook](#4-use-it-in-ci-or-a-git-hook) | 5 minutes |

---

## 1. Try it without installing anything

Nothing is installed, nothing is configured, nothing runs.

```bash
npx @coreyhiggins/blastradius check "kubectl get pods"
npx @coreyhiggins/blastradius check "terraform destroy -auto-approve"
npx @coreyhiggins/blastradius check "ssh deploy@web01 'rm -rf /var/www'"
```

The third one is the interesting one. It reads what you are sending through
`ssh` and judges that separately, so the verdict names the `rm`, not the `ssh`.

See what your commands would be measured against:

```bash
npx @coreyhiggins/blastradius context
```

That prints your active cluster, Terraform workspace, `AWS_PROFILE`, and
`DOCKER_HOST`, which is how the same `kubectl delete` reads differently
against a local cluster than a production one.

---

## 2. Wire it into your agent

```bash
npx @coreyhiggins/blastradius install              # Claude Code
npx @coreyhiggins/blastradius install cursor       # Cursor
npx @coreyhiggins/blastradius install codex        # Codex CLI
```

Each prints a config snippet. Paste it into the file it names.

Claude Code users can install the plugin instead, which also gives you a
`/blastradius` command for asking about a command mid-conversation:

```
/plugin marketplace add coreyhiggins/blastradius
/plugin install blastradius
```

**What changes afterwards:** nothing, most of the time. Building, testing,
committing, and reading files all stay silent. The first time you notice it
is when your agent tries to reach past your machine.

**One caveat on Codex.** Its hook cannot prompt, only block, so blastradius
denies there and tells you to re-run the command yourself. See the README.

---

## 3. Teach it your project's rules

The built-in rules know that `systemctl restart` is routine. They cannot know
that `mc-cobblemon` is a game server with forty people connected to it.

Most teams already have these rules written down as prose, in a CLAUDE.md or a
runbook, where they work only as long as somebody remembers them. A
`.blastradius.json` in your project root turns them into checks.

Four worked configs in this directory, all verified in CI:

| | |
|---|---|
| [`solo-managed.json`](solo-managed.json) | Working alone on Vercel, Supabase, Firebase, Railway. Guards deploys to live, database resets, live payment keys, and losing your own uncommitted work. |
| [`web-deploy.json`](web-deploy.json) | A web app on a shared VPS with nginx and systemd. |
| [`game-server.json`](game-server.json) | Live game servers, where a routine restart is not routine with players connected. |
| [`data-team.json`](data-team.json) | Warehouses and pipelines, where the expensive mistakes are often read-shaped. |

Test a rule before you trust it:

```bash
npx @coreyhiggins/blastradius check "systemctl restart mc-cobblemon"
```

**Two mistakes worth avoiding.**

`notice` never interrupts. It shows up in `check` and nowhere else. If you
wrote a rule because you want to be told, use `confirm`.

Gate patterns on a verb, not a bare name. `"pattern": "servers/prod"` matches
`tail` and `ls` just as happily as `rm`. Reading is not changing:

```json
"when": { "pattern": "(rm|mv|cp|chown|systemctl\\s+restart)\\b.{0,40}servers/prod" }
```

An audit of 166 real commands found every false positive traced to a bare
substring. One flagged a runbook's own documented safe-to-restart check.

**Never commit a config with infrastructure detail in it.** Host names, IP
addresses, key paths, and account identifiers belong in a gitignored file.

---

## 4. Use it in CI or a git hook

`check` exits 0 for safe and 2 for anything needing confirmation, so it
composes with anything that reads exit codes.

**Guard a deploy script from itself:**

```bash
#!/usr/bin/env bash
set -euo pipefail

CMD="terraform apply -auto-approve"

if ! npx -y @coreyhiggins/blastradius check "$CMD"; then
  echo "Refusing to run unattended. Run it by hand if you meant it."
  exit 1
fi

eval "$CMD"
```

**Review a script before merging it:**

```yaml
# .github/workflows/review-scripts.yml
- name: Check what the deploy script reaches
  run: |
    while IFS= read -r line; do
      npx -y @coreyhiggins/blastradius check "$line" || true
    done < <(grep -vE '^\s*(#|$)' deploy.sh)
```

**Use it from your own code:**

```js
const { assess } = require('@coreyhiggins/blastradius');

const verdict = assess('kubectl delete ns payments');
// { severity: 'danger', radius: 'remote', reasons: [...], findings: [...] }

if (['confirm', 'danger'].includes(verdict.severity)) {
  console.warn(verdict.reasons.join('\n'));
}
```

`assess` takes an options object: `cwd` for wrapper resolution, `context` to
supply cluster and workspace values yourself, and `config: null` to ignore any
`.blastradius.json` on disk.

---

## What it will not do

It is not a sandbox and not a recovery tool. It cannot stop a command, only
ask, and it cannot undo anything at all. It reads command strings, so an
unknown binary that wraps `kubectl` is invisible to it.

The full threat model is in [SECURITY.md](../SECURITY.md), and it is worth
reading before you rely on this for anything that matters.
