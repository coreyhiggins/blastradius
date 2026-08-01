# Contributing

The most useful contribution is almost always a **rule change**, and you do
not need to understand the codebase to make one.

## The two kinds of bug

**A false positive** is when the guard interrupts you for something safe.
These are real bugs, not cosmetic ones. Every unnecessary prompt makes someone
more likely to uninstall the tool, and an uninstalled guard protects nobody.

**A bypass** is when something genuinely destructive and remote comes back
`ok`. These are worse, because the tool looks like it is working. See
[SECURITY.md](SECURITY.md).

Report either with the exact command and the verdict:

```bash
npx @coreyhiggins/blastradius check "the command that was judged wrong"
```

## Changing a rule

Rules live in [`src/rules.js`](src/rules.js) as data, not code. Adding or
fixing one is usually a few lines.

The one thing to get right: **gate patterns on a verb, not a bare name.**

```js
// Wrong. Matches `tail`, `ls`, and `sha256sum` as readily as `rm`.
match: ['thing'], destructive: (argv) => argv.join(' ').includes('/srv/prod')

// Right. Reading is not changing.
destructive: (argv) => /^(rm|mv|cp|chown)$/.test(argv[0]) && touchesProd(argv)
```

An audit of 166 real-world commands found that *every* false positive traced
to a pattern matching a bare substring. One flagged a runbook's own documented
safe-to-restart check as `danger`.

Keep the two axes separate. `reach` is how far the damage travels. `destructive`
is whether state is removed or overwritten. Only the intersection interrupts
anyone, which is what keeps the tool quiet enough to stay installed.

## Tests

```bash
node test/run-tests.js
```

No framework, no dependencies, no install step. It runs on a clean checkout.

**Every rule change needs a test, and ideally two:** one proving the risky
command is caught, one proving a similar safe command is not. The second is
the one people forget, and it is the one that prevents the next false positive.

If you are adding a way for someone to slip past the parser, add it to the
`BYPASS:` block. Those tests are the reason anyone should trust this.

## What gets merged quickly

- A bypass, with a failing test
- A false positive, with a failing test
- A new tool in the rule table that reaches beyond the machine, with tests
- Support for another agent harness

## What needs discussion first

- Anything that lets config **weaken** the guard. There is no allowlist by
  design, and the reasoning is in [SECURITY.md](SECURITY.md). If you have a
  case that needs one, open an issue and make it, but expect the bar to be high.
- Adding a runtime dependency. Zero is a feature.
- Anything that makes the tool talk during safe commands.

## House style

Match the surrounding code. It is plain CommonJS, no build step, comments that
explain *why* rather than restating the line.

No em dashes or en dashes anywhere, in code, comments, docs, or commit
messages. CI enforces this.
