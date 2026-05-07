# Knowledge base

The per-repo knowledge base (KB) is a durable, append-only store of repo-scoped
lore that agents consult at the start of every skill run and contribute to at
the end of successful runs. Each repo's KB lives in that repo's GitHub Wiki —
separate from the code history, human-browseable, and append-only by design.
For the formal specification see [SPEC.md §23](../SPEC.md#23-knowledge-base)
(implementation: #226).

---

## Contents

- [Page layout](#page-layout)
- [Enabling KB on a new repo](#enabling-kb-on-a-new-repo)
- [Disabling KB](#disabling-kb)
- [Reading and editing KB content as a human](#reading-and-editing-kb-content-as-a-human)
- [Pruning](#pruning)
- [Troubleshooting](#troubleshooting)
- [Trust model](#trust-model)
- [Cross-references](#cross-references)

---

## Page layout

Each repo's wiki contains one **global** page and one **per-persona** page:

| Wiki page | Scope | Who reads it |
|-----------|-------|--------------|
| `KB-Global.md` | All personas | Every agent on every skill run |
| `KB-Conductor.md` | conductor | conductor agents only |
| `KB-Crafter.md` | crafter | crafter agents only |
| `KB-Glue.md` | glue | glue agents only |
| `KB-Optimizer.md` | optimizer | optimizer agents only |
| `KB-Orchestrator.md` | orchestrator | orchestrator agents only |
| `KB-Scribe.md` | scribe | scribe agents only |
| `KB-Skeptic.md` | skeptic | skeptic agents only |
| `KB-Theorist.md` | theorist | theorist agents only |
| `KB-Tinkerer.md` | tinkerer | tinkerer agents only |

Pages are created automatically the first time a persona writes an entry.
An agent that has never written an entry for its persona page will still
read the global page.

**Entry format.** Each entry is prepended to the top of its page, newest
first:

```markdown
<!-- 2026-05-07 | source: #272 | scribe -->
Operators need a `docs/knowledge-base.md` runbook; the canonical reference
is SPEC.md §23. Keep the two in sync when the KB spec changes.
```

Entries are plain Markdown separated by blank lines. The comment header
identifies when the entry was written, what issue or PR surfaced the
insight, and which persona recorded it.

---

## Enabling KB on a new repo

1. **Confirm wiki write permission.** The GitHub App installation must have
   **Contents: Read & write** on the wiki (which is a separate git
   repository at `https://github.com/<owner>/<repo>.wiki.git`). Verify in
   _Settings → GitHub Apps → your installation → Repository permissions_.

2. **Initialize the wiki via the GitHub UI.** GitHub wikis are lazily
   initialized — the wiki git repo does not exist until the first page is
   created through the GitHub interface. Go to your repo →
   _Wiki → Create the first page_, save any placeholder content. This
   unblocks the agent's clone step.

3. **Ensure `KB_ENABLED=true` (the default).** If you have previously set
   `KB_ENABLED=false` on the agent container, remove or unset that variable
   and restart the agent.

Once these three steps are done, the next agent skill run on the repo will
clone the wiki, create any missing pages, and inject the KB content into the
skill prompt.

---

## Disabling KB

Set `KB_ENABLED=false` on the agent container (or Docker Compose service)
and restart the agent.

**Effects:**
- The agent skips the wiki clone entirely — no network call is made to the
  wiki remote.
- `KB_CLONE_DIR` is set to an empty string in the skill environment; skill
  prompts detect this and skip all `cat $KB_CLONE_DIR/...` and
  `agentify-kb append` steps.
- Existing wiki content is untouched — pages already written remain in the
  wiki and will be read again if KB is re-enabled later.

Disabling KB has no effect on code worktree preparation, session management,
or any other part of the skill run.

---

## Reading and editing KB content as a human

Go to **GitHub → your repo → Wiki**. Each page (`KB-Global`, `KB-Tinkerer`,
etc.) is editable directly in the GitHub web UI.

Direct human edits are fully supported — the KB is a normal git-backed wiki.
You can add context, fix a wrong entry, or restructure a page without any
special tooling.

`agentify-kb` is the CLI the agents use to write entries. It handles
git fetch → rebase → push with retry-on-race-condition logic. You do not
need to use it as a human operator; the GitHub wiki editor is the intended
human interface.

---

## Pruning

To remove an entry, edit the relevant wiki page directly in the GitHub UI and
delete or replace the text. Agents will not re-create pruned content —
`agentify-kb append` only prepends new entries; it never restores missing
ones.

If a persona page accumulates noise, delete the page entirely via the wiki
UI. The agent will recreate an empty page on its next run and start fresh.

---

## Troubleshooting

### `KB_CLONE_DIR is empty` / KB skipped

**Symptom:** Agent log shows `KB skipped` or skill output shows no KB
context injected.

**Cause (most likely):** The wiki has not been initialized. GitHub returns
404 on clone of an uninitialized wiki, so the agent falls back to
`kbCloneDir = null`.

**Fix:** Initialize the wiki via the GitHub UI (see
[Enabling KB on a new repo](#enabling-kb-on-a-new-repo)), then re-trigger
the skill run by removing the in-progress label and re-applying the routing
label:

```sh
gh issue edit <number> -R owner/repo \
  --remove-label "agent:tinkerer:implement-in-progress" \
  --add-label "agent:tinkerer:implement"
```

**Secondary cause:** `KB_ENABLED=false` is set on the agent. Check the
container env and restart if needed.

---

### `agentify-kb append: push rejected`

**Symptom:** Agent log shows a push rejection from the wiki remote during
`agentify-kb append`.

**Cause:** Two agents wrote to the same wiki page concurrently (non-fast-forward
push). The `agentify-kb` CLI retries automatically: it attempts
`git push --force-with-lease`; on rejection it pauses with exponential backoff,
runs `git pull --rebase` to incorporate the latest remote tip, then re-pushes —
up to `KB_WRITE_RETRY_MAX` attempts (default 3) in total.

**If retries are exhausted:** The KB write fails with `task_error` for the KB
write only; the underlying skill job continues unaffected.

**If the failure persists after retries:** The installation token may lack
wiki write permission. Check the GitHub App permission settings (see step 1
of [Enabling KB on a new repo](#enabling-kb-on-a-new-repo)). After fixing
permissions, re-trigger the job.

---

### KB pollution / spam entries

**Symptom:** A wiki page contains repeated, low-quality, or clearly wrong
entries.

**Cause:** An agent wrote low-signal content, or a misbehaving job ran
multiple times.

**Fix:** Edit the wiki page directly in the GitHub UI and remove the
unwanted entries. Note that the hijack detector covers issue bodies before
dispatch, not KB pages — a compromised entry in the wiki could influence
future agent runs, so prune promptly. See the [Trust model](#trust-model)
section below.

---

## Trust model

KB pages are **semi-trusted DATA** — they are written by agents and read by
agents, but they are not executable instructions and are not implicitly
trusted to override skill procedure. A malicious or corrupted KB entry can
influence agent reasoning via context injection; treat unexpected agent
behavior on repos with compromised wikis as a prompt-injection incident.

The `SECURITY_PREAMBLE` in the agent system prompt (updated in #266) covers
this boundary: agents are instructed that KB page content is DATA describing
accumulated lore, not an extension of their operating instructions. Direct
human edits and agent-written entries are treated with the same level of
trust.

For the full threat model see [SPEC.md §22 Security model](../SPEC.md#22-security-model).

---

## Cross-references

- **[SPEC.md §23](../SPEC.md#23-knowledge-base)** — formal specification:
  storage layout, read/write paths, disabled mode, and the trust model.
- **[SPEC.md §22](../SPEC.md#22-security-model)** — security model and
  prompt-injection mitigations.
- **[docs/operations.md](operations.md)** — general operator playbook
  (halt/resume, stuck jobs, failure outcomes, database surgery).
- **Agent env vars** (`KB_ENABLED`, `KB_CLONE_DIR`) — see the Agent env
  table in [README.md](../README.md#agent-env).
- **Implementation** — issue #226 and its child issues track the full KB
  rollout.

---

🎯 **The Orchestrator** · Project Manager
