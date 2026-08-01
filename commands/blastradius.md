---
description: Check how far a shell command reaches before running it, or audit the current project's guard rules
argument-hint: "[command to check]"
allowed-tools: Bash(node:*), Read, Glob
---

# blastradius

Author: Corey

Work out how far a command reaches before anything runs it.

## If the user supplied a command

Run it through the classifier and report the verdict:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/blastradius.js" check "$ARGUMENTS"
```

Relay the result plainly. Do not soften a `DANGER` verdict, and do not add
reassurance the tool did not give. If the verdict is `confirm` or `danger`,
say what would change and where, then stop and let the user decide. Never run
the command yourself as a follow-up unless they explicitly ask.

## If the user supplied nothing

Give them a picture of this project's guard posture:

1. Show what the commands in this session would actually be judged against:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/blastradius.js" context
   ```

   That prints the active cluster context, terraform workspace, AWS profile,
   and docker host. Point out anything whose name looks like production.

2. Look for a `.blastradius.json` in the project root and in the user's home
   directory. If one exists, summarize the custom rules: what each one
   catches and why. If none exists, say so and offer to write one.

3. If you offer to write a config, base it on what this project actually is.
   Read any CLAUDE.md, `.claude/rules/*.md`, deploy scripts, systemd units,
   compose files, or Terraform in the repo, and look for prose rules a human
   wrote for themselves. Lines like "never touch X", "do not restart Y",
   "production is Z" are exactly what belongs in a config, because right now
   they depend on somebody reading and remembering them.

## The rules of this tool, for your own behaviour

- Custom rules can only **escalate**. There is no way to allowlist a command,
  and that is deliberate: an agent can write files, so a config that could
  weaken the guard would be the first thing worth attacking. If the user asks
  you to silence a false positive, tell them it belongs in `src/rules.js` as
  a pull request, where a human reviews it.
- The guard **asks**, it does not block. The user knows things it does not.
- A `notice` is not a reason to stop. Local and machine-level work is theirs
  to do.
