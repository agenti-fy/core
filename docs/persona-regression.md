# Persona regression runbook

When a slimmed persona misses something it should have caught, this runbook
tells you what to do. It applies to every persona trimmed in PR #75
(**skeptic, scribe, crafter, glue**) and to those slimmed in PR #58
(**theorist, tinkerer, optimizer, conductor, orchestrator**) once that lands.

---

## What "regression" looks like

A regression is a missed concern a working persona should have flagged.
For **The Skeptic** (the most security-load-bearing persona), concrete examples:

- Skeptic approves a PR that hardcodes a secret (API key, token, password) in
  source or test fixtures without flagging it.
- Skeptic approves a change that constructs a SQL query or shell command by
  concatenating unvalidated user input.
- Skeptic approves an auth-middleware change without commenting on the auth
  path at all.
- Skeptic approves a crypto change that uses MD5 or SHA1 for anything
  security-sensitive (password hashing, HMAC, certificate fingerprints).
- Skeptic approves a file-serving call that doesn't validate the path against
  a root, enabling directory traversal.

---

## When to act

**One confirmed miss on a security-sensitive PR is enough.** Do not wait for a
pattern.

**"Security-sensitive PR"** means the diff touches any of: authentication or
authorisation logic, cryptographic operations, secrets handling, user-controlled
input parsed into queries or commands, shell or SQL construction, file paths
derived from user input.

---

## Rollback recipe

> **Do not revert PR #75.** The Skeptic's approval note said it plainly:
> *"If review quality regresses on a future security-sensitive PR, the fix is
> to add specifics back to the relevant persona — not to revert this PR."*
> The Conductor confirmed: *"easy to add specifics back to any individual
> persona if review quality regresses on a future PR."*

**Step 1 — Identify the missed concern category.**

Name it precisely: SQL injection, hardcoded secrets, missing auth check, weak
crypto, path traversal, etc. One category per fix.

**Step 2 — Open the persona file.**

```
packages/agent/src/personas/<persona>.md
```

**Step 3 — Add a tight, targeted checklist section.**

Append a new `## <Category> checklist` section with 3–6 bullets addressing
only the missed category. The model already knows general security fundamentals;
you are adding a *project-specific reminder*, not a tutorial.

Example addition for hardcoded secrets:

```markdown
## Secrets checklist

- No hardcoded credentials, tokens, or keys — not in src, not in test fixtures
- Env vars for secrets are read via a single config layer; raw `process.env`
  access is only in that layer
- Secret values are never logged or returned in API responses
```

**Step 4 — Reference the pre-#75 content for inspiration.**

The full verbose checklist removed in #75 is preserved in the PR diff:

```sh
gh pr diff 75 -R agenti-fy/core -- packages/agent/src/personas/skeptic.md
```

The `-` lines are the removed content. Cherry-pick specific bullets; do not
paste an entire section back.

**Step 5 — Verify.**

`packages/agent/src/skills/resolver.ts` prepends the persona file to every
SDK call's system prompt. Changes take effect on the next agent restart — no
code change required.

---

## What NOT to do

- **Do not revert PR #75.** That undoes a correct decision to slim content the
  model already has from training.
- **Do not re-bloat with general security knowledge.** Pasting back the full
  OWASP Top 10 adds noise without signal.
- **Do not add a broad checklist** hoping to cover everything — over-long
  checklists dilute attention.
- **Do not fix all personas at once** if only one regressed. Targeted fixes
  stay auditable; blanket additions drift back toward pre-#75 verbosity.

---

📝 **The Scribe** · Documentation Specialist
