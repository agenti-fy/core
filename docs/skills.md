# Skills

A **skill** is the prompt sent to a model when it is dispatched to handle one
step in a workflow. Each skill is a Markdown document with template tokens
(`{{repo}}`, `{{target_id}}`, etc.) that are filled in at dispatch time.

This document is the authoritative reference for soul authors who want to
understand or override skill prompts.

---

## Skill set

There are five skills, one per method. The coordinator dispatches work by
posting to the agent's HTTP endpoint for the relevant method.

| Method | Key (`Method` type) | Bundled prompt | HTTP route |
|---|---|---|---|
| Plan | `plan` | `packages/agent/src/skills/defaults/plan.md` | `POST /plan` |
| Implement | `implement` | `packages/agent/src/skills/defaults/implement.md` | `POST /implement` |
| Review | `review` | `packages/agent/src/skills/defaults/review.md` | `POST /review` |
| Address Review | `address_review` | `packages/agent/src/skills/defaults/address-review.md` | `POST /address-review` |
| Merge | `merge` | `packages/agent/src/skills/defaults/merge.md` | `POST /merge` |

Routes are registered in `packages/agent/src/routes/methods.ts` using
`METHOD_PATHS` from `packages/shared/src/methods.ts`.

---

## Resolution order

Source: `packages/agent/src/skills/resolver.ts:68-90`

For each dispatch the runner calls `resolveSkill()`, which picks the skill
body in this order:

1. **SOUL.md override** — if the soul's `## Skill: <method>` section exists
   and its body is non-empty, that body is used.
2. **Bundled default** — otherwise the file from `defaults/<method>.md` is
   read and cached.

An empty `## Skill:` section is treated as "no override" and falls through
to the bundled default (`resolver.ts:64`). This prevents an accidental blank
section from silently sending an empty prompt.

After the body is chosen, only `{{signature}}` is interpolated into the
template (`resolver.ts:82-84`). The four per-job tokens (`{{repo}}`,
`{{target_id}}`, `{{persona}}`, `{{agent_name}}`) are left as literal
placeholders; their values are appended as a trailing **Task vars** block
and the two together form `skillPrompt`.

---

## Template tokens

Tokens use the form `{{token_name}}`. Unknown tokens are passed through
unchanged rather than replaced with an empty string.

| Token | Value | Source | Where it appears |
|---|---|---|---|
| `{{repo}}` | Repository slug, e.g. `owner/repo` | `ResolveOptions.repo` | Task vars block |
| `{{target_id}}` | Issue or PR number (string) | `ResolveOptions.target_id` | Task vars block |
| `{{agent_name}}` | Soul `name` frontmatter field | `soul.frontmatter.name` | Task vars block |
| `{{persona}}` | Routing-label persona segment | See note below | Task vars block |
| `{{signature}}` | Closing line for GitHub comments | See note below | Stable template body |

**`{{persona}}`** — for built-in souls (orchestrator, conductor, theorist,
tinkerer, optimizer, glue, skeptic, crafter, scribe) this equals the soul's
`type`. For custom souls it equals the soul's `name`, because using `type`
would interpolate the literal string `"custom"` and produce an invalid routing
label. Source: `resolver.ts:54-59`.

**`{{signature}}`** — resolution order: soul `signature` frontmatter field →
`PERSONA_DEFAULTS[type].signature` for built-ins → `soul.frontmatter.name`
for custom souls. Source: `resolver.ts:119-125`.

**Common uses in bundled prompts:**

The bundled defaults still contain literal `{{persona}}`, `{{target_id}}`,
and `{{agent_name}}` tokens in their bodies. Because these are no longer
substituted into the template, the model reads their values from the
trailing **Task vars** block and applies them when executing commands.

- `--remove-label "agent:{{persona}}:plan"` — the model substitutes the
  `Persona:` value from Task vars to build the correct label for this run.
- `Closes #{{target_id}}` — the model uses the `Target:` value from Task vars.
- `{{signature}}` at the end of every GitHub comment or issue body — this
  token IS interpolated directly into the stable template.

---

## Bundled defaults

### Plan (`defaults/plan.md`)

Reads the parent issue, deeply investigates the codebase (modules, entry
points, real file paths, tests), and decomposes the work into as many atomic
child issues as the scope requires. Each child issue carries exactly one
`agent:<persona>:<method>` label so it is dispatched automatically. The
prompt then rewrites the parent issue body as a structured plan document
(problem framing → current state → target state → approach → alternatives
considered → risks & unknowns → test strategy → out of scope → subtask
checklist) and removes the `agent:{{persona}}:plan` routing label from the
parent.

Output signal: `{ "child_issues": [<numbers>] }`.

### Implement (`defaults/implement.md`)

Creates a branch named `feat/{{agent_name}}/{{target_id}}-<short-slug>` from
the default branch, makes atomic commits, pushes, and opens a PR with a body
that references the issue (`Closes #{{target_id}}`), describes what/why/how to
verify, and is signed with `{{signature}}`. Removes the
`agent:{{persona}}:implement` routing label from the source issue.

Output signal: `{ "branch": "<branch>", "pr_number": <n> }`.

### Review (`defaults/review.md`)

Fetches the PR diff and linked issues, evaluates the change from the persona's
specialty perspective, and posts a single GitHub review with one of three
verdicts: `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`. Removes the
`agent:{{persona}}:review` routing label from the PR. The prompt enforces that
the reviewer stays in their specialty lane and does not block for issues
belonging to another reviewer's domain.

Output signal: `{ "review_id": <n>, "verdict": "approved" | "changes_requested" | "commented" }`.

### Address Review (`defaults/address-review.md`)

Reads the most recent `CHANGES_REQUESTED` reviews and inline comments,
implements or disputes each point (disputes are posted as PR comment replies,
not new reviews), pushes commits to the PR branch, resolves addressed inline
threads, and removes the `agent:{{persona}}:address-review` routing label. The
coordinator automatically re-routes reviewers after the new HEAD is detected.

Output signal: `{ "commits_pushed": <n>, "rerequested": <bool> }`.

### Merge (`defaults/merge.md`)

Confirms all required reviewers have approved and no `CHANGES_REQUESTED`
reviews remain. If the PR is behind the default branch, rebases and resolves
conflicts (running typecheck/lint/tests to verify the resolved tree) before
force-pushing with lease. Merges via `gh pr merge --squash --delete-branch`,
closes the linked issue if not already auto-closed, and strips all `agent:*`
routing labels from the now-merged PR. Falls back to `needs-human` only when
conflicts require product judgment that cannot be derived from the diff and
commit history.

Output signal: `{ "merged": <bool>, "closed_issue": <number?> }`.

---

## Writing a custom skill

Add a `## Skill: <method>` section anywhere after the frontmatter in your
`SOUL.md`. The heading slug is case-insensitive and dashes/underscores are
normalized, so `## Skill: Address-Review`, `## Skill: address_review`, and
`## Skill: ADDRESS_REVIEW` all target the same method.

The section body replaces the bundled default entirely — it is not merged or
appended. Leave the section absent (or empty) to keep the bundled default.

**Example `SOUL.md`:**

```markdown
---
name: doc-bot
type: custom
signature: "📝 **Doc Bot** · Documentation Specialist"
---

You are Doc Bot, a specialist in Markdown documentation. You write clearly,
cite real file paths, and never pad prose.

## Skill: implement

You have been called on issue **#{{target_id}}** in **{{repo}}**.

## Goal

Write or update the Markdown documentation described in the issue. Open a
pull request titled with the issue title.

## Procedure

1. Read the issue: `gh issue view {{target_id}} -R {{repo}}`.
2. Identify every file path mentioned. Verify each exists.
3. Create a branch: `git checkout -b docs/{{agent_name}}/{{target_id}}-<slug>`.
4. Write the documentation. Keep prose tight; prefer tables over paragraphs
   for reference material.
5. Open a PR:
   ```bash
   gh pr create -R {{repo}} \
     --title "$(gh issue view {{target_id}} -R {{repo}} --json title -q .title)" \
     --body "Closes #{{target_id}}

   📝 **Doc Bot** · Documentation Specialist"
   ```
6. Remove your routing label:
   ```bash
   gh issue edit {{target_id}} -R {{repo}} \
     --remove-label "agent:{{persona}}:implement"
   ```

## Output

`{ "branch": "<branch>", "pr_number": <n> }`
```

All five tokens are available in every skill body regardless of whether it
comes from SOUL.md or the bundled default. `{{signature}}` is interpolated
directly into the stable template. The remaining four (`{{repo}}`,
`{{target_id}}`, `{{agent_name}}`, `{{persona}}`) appear in the **Task vars**
block appended after the skill body — the model reads that block and uses the
values when executing commands in the prompt.

---

## Persona vs skill

These two concepts are distinct; confusing them leads to prompts that don't
behave as expected.

| | Persona body | Skill body |
|---|---|---|
| **What it is** | "Who the agent is" | "What to do right now" |
| **SDK role** | `systemPrompt` (appended to the `claude_code` preset) | `prompt` (user message) |
| **Stays stable across session turns?** | Yes — set once at session start | No — changes per method dispatch |
| **Where it comes from** | Text before the first `## Skill:` heading (or built-in personas file) | `## Skill: <method>` section, else bundled default |

Source: `packages/agent/src/claude/live.ts:101-118` (SDK call assembly),
`packages/agent/src/skills/resolver.ts:33-44` (`ResolvedSkill` interface).

For built-in persona types the persona body is loaded from
`packages/agent/src/personas/<type>.md`; for custom souls the body is the text
that appears before the first `## Skill:` heading in `SOUL.md`
(`packages/agent/src/soul/parser.ts:58` and `resolver.ts:92-117`).
