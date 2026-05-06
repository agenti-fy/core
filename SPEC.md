---
project: agenti-fy
version: 0.1.0
status: current
language: TypeScript
runtime: Node 22+
package_manager: pnpm
generated: 2026-05-06
predecessor: ../agenti-fi (XState/SQLite/long-lived poller architecture)
---

# agenti-fy — Spec

A multi-agent software development system in TypeScript, deployed as a small set of Docker containers that coordinate through GitHub. Each **agent** is an HTTP RPC service driven by the Claude Code SDK; a **coordinator** is a thin, stateful router that polls GitHub and dispatches work.

## 1. Motivation

The previous iteration (`../agenti-fi`) embedded the entire orchestration loop, agent FSMs, knowledge base, plugins, CLI, dashboard, and rate limiter into one monolith. This iteration deliberately strips the system to its load-bearing pieces:

- **Service-oriented**: each agent is its own container with a tiny RPC surface.
- **Coordinator is dumb on purpose**: a state machine, not an SDK consumer. It polls GitHub, holds the source-of-truth DB, and dispatches.
- **Claude Code SDK does the thinking**: skills + sessions live inside the agent; the coordinator never invokes a model.
- **No knowledge base, no plugins, no dashboard, no auto-scaling** in this iteration.

## 2. High-level architecture

```
                ┌──────────────────────────────────────┐
                │              GitHub                  │
                │  (issues, PRs, labels, reviews)      │
                └────────────────┬─────────────────────┘
                                 │ Octokit (GitHub App)
                                 ▼
        ┌────────────────────────────────────────┐
        │          coordinator (container)       │
        │  ─ polls GitHub every N s              │
        │  ─ owns SQLite (sessions, jobs, repos) │
        │  ─ exposes /sessions, /repos, /halt    │
        │  ─ dispatches jobs via HTTP to agents  │
        │  ─ polls agent /status until IDLE      │
        └──────────┬───────────────┬─────────────┘
                   │ HTTP RPC      │ HTTP RPC
                   ▼               ▼
        ┌──────────────────┐  ┌──────────────────┐
        │   agent #1       │  │   agent #2       │ …
        │  SOUL.md mount   │  │  SOUL.md mount   │
        │  Claude Code SDK │  │  Claude Code SDK │
        │  Octokit         │  │  Octokit         │
        │  /workspaces vol │  │  /workspaces vol │
        └──────────────────┘  └──────────────────┘
```

Both coordinator and agents authenticate to GitHub as the **same GitHub App installation** (env vars repeated on each service).

## 3. Components

### 3.1 Agent service

A single Docker image (`agentify/agent`). Each running container is one *soul* — distinguished only by:

- A bind-mounted `SOUL.md` at `/etc/agentify/SOUL.md`.
- The 4 GitHub env vars (see §5).
- Its container hostname / network address.

#### Responsibilities

- On boot: parse SOUL.md, validate env, register with coordinator, expose HTTP API.
- On RPC: flip status to BUSY, run the matching skill via Claude Code SDK using the (per-agent, per-repo) session, persist resulting session_id back to the coordinator, flip to IDLE (or FAILURE).
- Maintain its own per-repo bare clone + per-job worktree at `/workspaces/<org>/<repo>/`.

#### Status

```ts
type Status = 'IDLE' | 'BUSY' | 'FAILURE';
```

- `IDLE` — no job in flight; willing to accept dispatches.
- `BUSY` — job in flight; rejects further dispatches with HTTP 409.
- `FAILURE` — sticky. Set only on **Claude SDK / auth / configuration** errors. Per-task errors return an error result but keep the agent IDLE. Cleared via `POST /reset`, which re-runs init (env validation, SOUL reload, Octokit re-auth, coordinator re-register). If init fails, FAILURE re-asserts.

#### Type (persona)

`type` is declared in SOUL.md frontmatter and names the agent's **persona** — its style, voice, and area of focus. It does **not** restrict which RPC methods the agent will accept: any persona can answer any of the five methods (Plan / Implement / Review / AddressReview / Merge). The persona is a routing hint used by the coordinator and a flavor signal injected into every Claude prompt.

The supported persona set is carried over from the previous iteration (see §3.3); custom personas are allowed by setting `type: custom` and supplying the persona prose in the SOUL body. `supported_methods` may still be present in the register payload for forward compatibility, but in v1 it is always the full five-method set.

### 3.2 Coordinator service

A single Docker image (`agentify/coordinator`). One per stack.

#### Responsibilities

- Maintains SQLite at `/data/coordinator.db` (mounted volume).
- Auto-discovers managed repos via the GitHub App installation (`GET /installation/repositories`); list refreshed on a slow cadence.
- Polls each repo every **30 s by default** (configurable per-repo) for:
  - Issues with `agent:*` routing labels and no in-flight job.
  - PRs with `agent:*` routing labels.
  - Issues bearing the `halt-agents` label (emergency stop).
- Dispatches matching jobs to an IDLE agent of the appropriate type.
- Polls each agent's `/status` to detect job completion (no inbound webhook).
- Serves session lookup/save RPC for agents.
- Exposes a control API (halt/resume, list agents, list jobs).

The coordinator **never invokes Claude** and **never writes code/PRs directly** — it only reads/writes labels and (rarely) posts a failure comment when a job fails.

### 3.3 Personas

Carried over from `../agenti-fi`. Each value below is a valid `type` in SOUL.md. Personas are **purely stylistic** — every one of them exposes all five methods. The mapping below is a strong default for routing (a planner-style item naturally goes to The Orchestrator, a security-oriented review naturally goes to The Skeptic), but humans may label work with any persona and that persona's agent will handle it.

| Type | Title | Focus | Natural method affinity |
|---|---|---|---|
| `orchestrator` | The Orchestrator · Project Manager | breaks epics into actionable issues, prioritizes, manages dependencies | Plan |
| `conductor` | The Conductor · Engineering Lead | resolves conflicts, unblocks, architectural guidance, escalation point | AddressReview, Merge |
| `theorist` | The Theorist · Systems Architect | designs solutions, writes specs, ensures architectural consistency | Plan, Review |
| `tinkerer` | The Tinkerer · Implementation Specialist | hands-on builder, iterates quickly on feedback | Implement, AddressReview |
| `optimizer` | The Optimizer · Performance Specialist | profiles, benchmarks, improves efficiency | Implement, Review |
| `glue` | The Glue · Integration Specialist | connectors, adapters, "boring but critical" plumbing | Implement, AddressReview |
| `skeptic` | The Skeptic · Security Reviewer | security, reliability, quality; reviews PRs before merge | Review |
| `crafter` | The Crafter · UI/UX Specialist | beautiful, accessible, intuitive frontends | Implement, Review |
| `scribe` | The Scribe · Documentation Specialist | turns technical complexity into clear knowledge | Implement, Review |
| `custom` | (operator-defined) | persona-as-prose in SOUL body | any |

Each persona has a default emoji + git identity that the runtime injects so commits, comments, and reviews are visibly attributable. The SOUL.md `git.{name,email}` and a (new) `signature` frontmatter field override these defaults.

| Persona | Emoji | Default git identity |
|---|---|---|
| orchestrator | 🎯 | `The Orchestrator <orchestrator@agentify.local>` |
| conductor    | 🎭 | `The Conductor <conductor@agentify.local>` |
| theorist     | 🧠 | `The Theorist <theorist@agentify.local>` |
| tinkerer     | 🔧 | `The Tinkerer <tinkerer@agentify.local>` |
| optimizer    | ⚡ | `The Optimizer <optimizer@agentify.local>` |
| glue         | 🔗 | `The Glue <glue@agentify.local>` |
| skeptic      | 🛡️ | `The Skeptic <skeptic@agentify.local>` |
| crafter      | 🎨 | `The Crafter <crafter@agentify.local>` |
| scribe       | 📝 | `The Scribe <scribe@agentify.local>` |

Comments, reviews, and PR descriptions written by an agent are prefixed with a one-line signature header so authorship is visible in GitHub UI:

```markdown
> 🛡️ **The Skeptic** · Security Reviewer

---

<comment body>
```

The persona body in SOUL.md is loaded once at boot and prepended to every Claude Code SDK call as system context. Default persona bodies for the nine built-ins ship inside the image at `/personas/<type>.md`; a SOUL.md may either reference one (`type: skeptic` with no body → use the default) or replace it entirely (body present → use the SOUL body).

## 4. SOUL.md format

```markdown
---
name: tinkerer-01
type: tinkerer               # one of the 9 built-in personas, or 'custom'
version: 1.0.0
git:
  name: The Tinkerer
  email: tinkerer@agentify.local
signature: "🔧 **The Tinkerer** · Implementation Specialist"
models:
  plan:           claude-opus-4-7
  implement:      claude-sonnet-4-6
  review:         claude-opus-4-7
  address_review: claude-sonnet-4-6
  merge:          claude-sonnet-4-6
# Optional. If omitted, defaults to all five. v1 ignores any value other than
# the full set — every persona handles every method.
supported_methods: [plan, implement, review, address_review, merge]
---

# The Tinkerer

You are The Tinkerer. <persona prose, examples, principles, hard rules…>
# (Optional — omit this whole body to use the bundled default persona for `type: tinkerer`.)
```

- **Frontmatter fields** parsed by the runtime: `name` (unique), `type` (persona), `version`, `git.{name,email}`, `signature`, `models.*`, optional `supported_methods`.
- **Body** is the persona prose appended to every Claude Code SDK call's system context. If absent and `type` is one of the nine built-ins, the bundled `/personas/<type>.md` is used instead.
- **Per-method skill prompts** ship as defaults at `/skills/{plan,implement,review,address-review,merge}.md`. A SOUL.md MAY override any skill inline by adding `## Skill: <method>` (e.g. `## Skill: plan`) sections — those replace the default for that method.

## 5. Environment variables

| Var | Required on | Purpose |
|---|---|---|
| `GITHUB_APP_ID` | agent + coordinator | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | agent + coordinator | PEM contents (not path) |
| `GITHUB_APP_INSTALLATION_ID` | agent + coordinator | Installation ID |
| `GITHUB_USER` | agent + coordinator | App-as-user login (e.g. `agentify-bot[bot]`). Used to filter the agent's own comments/reviews when polling so we don't loop on our own actions. |
| `COORDINATOR_URL` | agent | Base URL of coordinator (e.g. `http://coordinator:8080`) |
| `AGENT_PORT` | agent | Port to bind (default 8080) |
| `AGENT_PUBLIC_URL` | agent | URL coordinator can reach this agent on (sent during /register) |
| `ANTHROPIC_API_KEY` | agent | For Claude Code SDK |
| `LOG_LEVEL` | both | pino level |
| `DATA_DIR` | both | Defaults: agent `/workspaces`, coordinator `/data` |

If any required var is missing on boot, the service exits non-zero (no in-place FAILURE for boot misconfig — fail loud).

## 6. Agent HTTP API

All endpoints return JSON. No app-level auth — trust is provided by the docker network. Schema validated via Fastify + zod.

### 6.1 Lifecycle / introspection

| Method | Path | Description |
|---|---|---|
| GET | `/health` | k8s-style liveness (cheap; returns 200 if the process is up) |
| GET | `/status` | `{ status, current_job?: { id, method, repo, target_id, started_at }, last_failure?: { code, message, ts } }` |
| GET | `/jobs/:id` | Full job record incl. result, claude transcript ref, structured logs |
| POST | `/reset` | Clear FAILURE by re-running init. Returns 200 if recovered, 409 if the agent is BUSY, 503 if init still fails. |
| GET | `/metrics` | Prometheus exposition (see §14). |

### 6.2 Work methods

All five share the same dispatch shape:

```http
POST /plan
POST /implement
POST /review
POST /address-review
POST /merge
Content-Type: application/json

{
  "repo": "<org>/<repo>",
  "id":   42,                  // issue # for plan/implement, PR # for review/address-review/merge
  "session_id": "abc123" | null  // coordinator-supplied; null = create new session
}
```

Response (immediate):

```http
202 Accepted
{ "job_id": "j_01H…", "agent_id": "ag_01H…", "status": "BUSY" }
```

If the agent is already BUSY: **`409 Conflict`** with `{ "error": "BUSY", "current_job_id": "…" }`. The coordinator routes elsewhere and retries.

If the agent is in FAILURE: **`503 Service Unavailable`** with `{ "error": "FAILURE", "last_failure": {...} }`.

If the SOUL doesn't support the method: **`405 Method Not Allowed`**.

### 6.3 Async result delivery

Coordinator-polled. The coordinator polls `GET /status` until the agent transitions BUSY → IDLE (or → FAILURE), then fetches `GET /jobs/:id` for the result. No webhooks in this iteration.

### 6.4 Job result schema

```ts
type JobResult = {
  job_id: string;
  method: 'plan'|'implement'|'review'|'address_review'|'merge';
  repo: string;
  target_id: number;
  outcome: 'success' | 'task_error' | 'sdk_failure' | 'auth_failure' | 'config_failure';
  session_id: string;          // session used / created (always returned, agent persists separately)
  duration_ms: number;
  artifacts: {
    plan?:           { child_issues: number[] };
    implement?:      { branch: string; pr_number: number };
    review?:         { review_id: number; verdict: 'approved'|'changes_requested'|'commented' };
    address_review?: { commits_pushed: number; rerequested: boolean };
    merge?:          { merged: boolean; closed_issue?: number };
  };
  error?: { message: string; stack?: string };
};
```

`task_error` keeps the agent IDLE; `sdk_failure | auth_failure | config_failure` flips it to FAILURE.

## 7. Coordinator HTTP API

| Method | Path | Description |
|---|---|---|
| POST | `/agents/register` | Agent calls on boot/restart. Body: `{ name, type, version, url, supported_methods }`. Returns `{ agent_id }` (UUID, coordinator-assigned; reused across restarts when `name` matches an existing record). |
| GET | `/agents` | List agents with last-known status & heartbeat. |
| GET | `/sessions/:agent_id/:org/:repo` | Returns `{ session_id }` or `404`. Called by the agent at job start. |
| PUT | `/sessions/:agent_id/:org/:repo` | Body: `{ session_id }`. Called by the agent after a successful job. Idempotent upsert. |
| GET | `/repos` | Discovered + managed repos and their poll cadence. |
| GET | `/jobs?status=open` | Active jobs (used for de-dupe & for ops). |
| POST | `/halt` | Set system-wide halt; coordinator stops dispatching. |
| POST | `/resume` | Clear halt. |

Coordinator does **not** expose direct dispatch endpoints for humans in v1 — all human levers are GitHub-side (labels) and `halt`/`resume`.

## 8. Workflow

### 8.1 Label vocabulary

Routing uses a **combined label** per (persona, method) pair, format `agent:<persona>:<method>`:

- `agent:orchestrator:plan`
- `agent:tinkerer:implement`
- `agent:skeptic:review`
- `agent:tinkerer:address-review`
- `agent:conductor:merge`
- (any persona × method combination; `agent:<custom-name>:<method>` for custom SOULs)

A single item may carry **multiple routing labels simultaneously** — for example `agent:skeptic:review` and `agent:scribe:review` — so multiple reviewers can process the same PR concurrently, each evolving its own label independently. (The previous two-label format `agent:<persona>` + `task:<method>` made this impossible: a shared `task:review` label couldn't survive once the first reviewer removed it. See `packages/shared/src/labels.ts` for the full rationale.)

The coordinator dispatches one job per routing label it finds, provided the item carries no matching in-progress marker.

**In-progress markers** — set by the receiving agent on accept; coordinator skips items already marked:

- `agent:<persona>:plan-in-progress`
- `agent:<persona>:implement-in-progress`
- `agent:<persona>:review-in-progress`
- `agent:<persona>:address-review-in-progress`
- `agent:<persona>:merge-in-progress`

**System labels:**

- `halt-agents` — on any issue, halts the entire system until removed.
- `needs-human` — applied by the coordinator on job failure; takes the item out of the routing pool until a human removes it.

### 8.2 Persona selection

Who picks the persona label?

- **Bootstrap**: the human (or external tool) opening an issue applies a combined routing label such as `agent:orchestrator:plan`.
- **Plan output**: the planner persona that handled the parent decides which persona should *implement* each child issue and labels accordingly. SOUL prompt for Plan includes the available persona roster (from coordinator's `/agents`) so the planner's choices are constrained to running personas.
- **Review output**: similarly, the reviewer persona (typically `skeptic`) chooses which persona should address feedback or perform the merge — usually the same persona that implemented the PR (recoverable from PR commit author or the `agent:<persona>:implement` label on the linked issue).

Any persona is *capable* of any method; persona selection is an editorial choice that shapes voice and judgment, not a capability gate.

### 8.3 Coordinator dispatch rules

For each `agent:<persona>:<method>` routing label the coordinator finds during a poll:

1. Extract `<persona>` and `<method>` from the combined label.
2. Find an IDLE registered agent whose `type` matches `<persona>`. If none is IDLE, skip (try next poll).
3. If multiple IDLE agents share the persona, pick least-recently-dispatched (round-robin).
4. Insert a `jobs` row with status `dispatched`; the partial unique index on (repo, method, target_id) blocks duplicate dispatch.
5. POST to the agent's `/<method>` endpoint. On 202 → mark `running`. On 409/503 → mark `failed_to_dispatch` and try a different IDLE agent of the same persona.

If a referenced persona has **no registered agent at all**, the coordinator applies `needs-human` with a comment explaining the missing persona.

### 8.4 End-to-end happy path

```
[human creates issue]
  └─ label: agent:orchestrator:plan
       │
       ▼
   coordinator → POST /plan to an orchestrator-type agent
       └─ agent flips: agent:orchestrator:plan → agent:orchestrator:plan-in-progress
       └─ agent runs Plan skill:
            - rewrites parent issue body (Summary / Plan / Subtasks)
            - creates child issues, each with:
                * "Parent: #<n>" link in body
                * label: agent:<chosen-persona>:implement
            - parent body gets a checklist of - [ ] #<child>
       └─ agent removes label from parent (planning done)
       │
       ▼
   coordinator → POST /implement for each child
       └─ agent flips: agent:<persona>:implement → agent:<persona>:implement-in-progress
       └─ agent creates branch  feat/<agent-name>/<issue#>-<slug>
       └─ agent runs Implement skill, commits as SOUL git identity
       └─ agent opens PR linking the child issue
       └─ agent removes label from issue
       └─ agent labels new PR: agent:skeptic:review (default reviewer persona)
       │
       ▼
   coordinator → POST /review on PR
       └─ agent flips: agent:skeptic:review → agent:skeptic:review-in-progress
       └─ agent runs Review skill, posts review
       └─ if changes_requested → set PR label agent:<implementer-persona>:address-review
       └─ if approved          → set PR label agent:conductor:merge
       │
       ┌────────────── changes_requested ──────────────┐
       ▼                                               ▼
   coordinator → POST /address-review on PR        coordinator → POST /merge on PR
       └─ agent pushes fixes, sets PR label          └─ agent rebases / resolves trivial
          back to agent:skeptic:review                 conflicts, merges PR, closes
          (loops back to Review)                       linked child issue (parent
                                                       auto-progresses via checkbox
                                                       flip in its body)
```

### 8.5 Plan output details

- **Parent issue body**: rewritten with sections (Summary / Plan / Subtasks). Subtasks are a markdown task list of `- [ ] #<child>` so GitHub auto-tracks completion.
- **Each child issue body**: `Parent: #<parent>` + the focused subtask spec.
- Children are created with label `agent:<persona>:implement` where the planner picks `<persona>` per child based on the work's nature (e.g. UI work → `crafter`, integration → `glue`, performance work → `optimizer`).

### 8.6 Two-phase post-review

The Review skill outputs only the review verdict. **AddressReview** and **Merge** are distinct methods, picked by the coordinator from the task label the reviewer set:

- `agent:<persona>:address-review` → POST `/address-review` (always: implement + push + re-request review)
- `agent:<persona>:merge`          → POST `/merge` (always: ensure clean, merge, close linked issue)

This avoids embedding "what to do next" inference inside a single addressing skill.

## 9. Session management

- One session per `(agent_id, repo)` pair.
- **Coordinator** is the source of truth — owns the `sessions` table.
- On dispatch, the coordinator:
  1. Looks up `session_id` for `(agent_id, repo)` and includes it in the dispatch body (`null` = no prior session).
- The agent:
  1. Uses the supplied `session_id` to invoke the Claude Code SDK (resume or fresh).
  2. After completion, `PUT /sessions/{agent_id}/{org}/{repo}` with the session id from the SDK.
- **Invalidate on auth/SDK errors only**: if the job ends with `outcome ∈ {sdk_failure, auth_failure}`, the agent does NOT save the session id (effectively dropping it). For ordinary `task_error`, the session is preserved so context isn't lost.
- The coordinator also exposes `GET /sessions/{agent_id}/{org}/{repo}` for out-of-band lookups (debug / TUI), but the dispatch flow doesn't depend on it.

## 10. GitHub integration

- Library: `@octokit/rest` + `@octokit/auth-app` on both services.
- Credentials: GitHub App (single installation per stack).
- Repos managed = `installation/repositories` from the App, refreshed every 5 minutes.
- All polls filter out comments/reviews authored by `GITHUB_USER` to avoid feedback loops on the agent's own writes.
- Branch naming: `feat/<agent-name>/<issue#>-<slug>` (slug derived from issue title; lowercased, dashed, truncated to 40 chars).
- Commit identity: `git config` set per worktree to the SOUL's `git.name`/`git.email`.
- Co-author trailer optional (carried-over convention from agenti-fi; not required in v1).

## 11. Persistence

### 11.1 Coordinator SQLite (better-sqlite3)

```sql
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,        -- UUID, coordinator-assigned
  name TEXT UNIQUE NOT NULL,        -- from SOUL.md
  type TEXT NOT NULL,
  version TEXT NOT NULL,
  url TEXT NOT NULL,                -- where to dispatch
  supported_methods TEXT NOT NULL,  -- JSON array
  registered_at INTEGER NOT NULL,
  last_heartbeat INTEGER
);

CREATE TABLE sessions (
  agent_id TEXT NOT NULL,
  repo TEXT NOT NULL,               -- "<org>/<repo>"
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, repo)
);

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  method TEXT NOT NULL,
  repo TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  status TEXT NOT NULL,             -- 'dispatched','running','complete','failed'
  outcome TEXT,                     -- from JobResult.outcome
  dispatched_at INTEGER NOT NULL,
  completed_at INTEGER,
  result_json TEXT,
  UNIQUE (repo, method, target_id, status)
    WHERE status IN ('dispatched','running')
);

CREATE TABLE repos (
  repo TEXT PRIMARY KEY,            -- "<org>/<repo>"
  poll_interval_s INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1,
  last_polled INTEGER
);

CREATE TABLE control (
  key TEXT PRIMARY KEY,             -- 'halted' etc.
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### 11.2 Agent local state

The agent itself keeps **no DB** — sessions are stored on the coordinator. On disk it owns only:

- `/workspaces/<org>/<repo>/.bare/` — bare clone (persistent).
- `/workspaces/<org>/<repo>/<job_id>/` — per-job worktree, `git worktree add` at start, `git worktree remove --force` at end of job (success or failure). The bare clone is kept hot for fast subsequent jobs.

A small in-memory job registry (`Map<job_id, JobRecord>`) backs `GET /jobs/:id`. On container restart, in-flight jobs are lost; the coordinator's de-dupe + label transition discipline (§12) re-discovers and re-dispatches.

## 12. Concurrency & idempotency

- **Per-agent**: only one BUSY job at a time. Subsequent dispatches → 409.
- **Per-repo at coordinator**: the coordinator's `jobs` table holds a partial unique index on `(repo, method, target_id)` for active rows, preventing duplicate dispatch even if multiple agents could pick it up.
- **Label-transition discipline**: agent flips `agent:<persona>:<method>` → `agent:<persona>:<method>-in-progress` on accept; coordinator skips items carrying a matching `*-in-progress` label while polling. Surviving coordinator restart, this is the visible source of truth — re-dispatch is safe because the in-progress item won't be re-picked until the label is cleared (which the agent does on completion or a stale-marker sweeper does after a configurable timeout).

## 13. Failure handling

| Class | Status effect | Recovery |
|---|---|---|
| Per-task error (skill fails / GH push fails / etc.) | IDLE | Job result has `outcome=task_error`. The agent posts a failure comment (or falls back to writing into the issue body) and atomically swaps the in-progress label for `needs-human`. **No automatic retry.** |
| Claude SDK / auth / config error returned by the adapter | FAILURE | Sticky. The agent posts a `needs-human` comment with the failure context and clears the in-progress label so the work poller does NOT re-route. Operator calls `POST /reset` after fixing the underlying issue. (Restoring the routing label would loop forever on the same broken state.) |
| Dispatch transport error | unchanged | Job stays in `dispatched` state. The job-completion poller reconciles via the agent's `/status` + `/jobs/:id`; if the agent has no record, the job is marked `orphaned` (failed) and the partial unique index is freed for re-dispatch. |
| Container crash mid-job | (container restarts) | Job lost in-memory; coordinator's poll re-discovers via labels and re-dispatches. Stale `*-in-progress` cleared by the sweeper after `STALE_JOB_TIMEOUT_S` (default 1800s = 30 min); the sweeper runs every `STALE_JOB_SWEEP_S` (default 600s = 10 min) and only restores routing labels for items whose corresponding job is no longer active. |
| Coordinator crash | n/a | SQLite is durable; on restart coordinator rebuilds in-flight view from `jobs` + GitHub label state. |

## 14. Observability

Every agent and coordinator container exposes:

- `GET /health` — liveness.
- `GET /status` (agent) / `GET /agents` (coordinator) — operational state.
- `GET /metrics` — Prometheus exposition (text format, `prom-client` defaults plus the metrics below). Each service uses a service-local Registry; default Node metrics carry the prefix `agentify_agent_*` / `agentify_coordinator_*`.

  **Coordinator metrics** (`agentify_coordinator_*` prefix on defaults):
  - `agentify_jobs_total{method,outcome}` — counter of completed jobs by final outcome.
  - `agentify_dispatched_total{method,kind}` — counter of dispatch attempts grouped by outcome kind (`accepted`, `busy`, `failure`, `method_not_supported`, `transport_error`, `rejected`).
  - `agentify_dispatch_latency_ms{method,kind}` — histogram of agent-RPC round-trip latency, capped at 10s (HTTP timeout).

  **Agent metrics** (`agentify_agent_*` prefix on defaults; `persona` default label set on registry):
  - `agentify_jobs_total{method,outcome}` — counter of skill runs.
  - `agentify_job_duration_ms{method,outcome}` — histogram of wall-clock skill duration (replaces the spec's earlier `agentify_busy_seconds_total`; the histogram captures the same data with shape).
  - `agentify_claude_tokens_total{kind}` — counter of Claude SDK tokens consumed (`input`, `output`, `cache_read`, `cache_write`), populated from the SDK's `usage` field.
  - `agentify_claude_cost_usd_total{method}` — cumulative USD cost from the SDK's `total_cost_usd`.

- **Structured JSON logs** to stdout via `pino`, including `{ agent_id, job_id, method, repo, target_id }` on every line for trivial filtering.

`GET /jobs/:id` returns full structured logs + a pointer to the Claude transcript path (for ad-hoc debugging).

## 15. Halt mechanism

Two equivalent triggers to **enter** halt:

1. **Label**: `halt-agents` on any issue in any managed repo. The coordinator's work poller detects this on the next cycle and flips `control.halted = true`.
2. **API**: `POST /halt` (or `PUT /control/halt {halted:true}`).

Halt is **only cleared explicitly**: `POST /resume` (or `PUT /control/halt {halted:false}`). Removing the label is NOT sufficient — the work poller's `since=` filter for incremental scans can hide a stale halt-bearing issue from later cycles, which would silently un-halt the system if we treated absence-of-observed-halt as "halt cleared". Operators clear halt deliberately.

While halted, the coordinator **does not dispatch new jobs**. In-flight jobs continue to completion. `/agents`, `/jobs`, and inspection endpoints stay live.

## 16. Deployment

### 16.1 docker-compose (dev + reference prod layout)

The repo's `docker-compose.yml` ships a **minimal reference stack** with the coordinator + three agents (orchestrator, tinkerer, skeptic) — enough to demonstrate Plan → Implement → Review end-to-end. Operators add the other six personas (conductor, theorist, optimizer, glue, crafter, scribe) by copying any agent block and pointing it at `./souls/<persona>.md`. The full nine-persona compose below is the **upper bound**, not the default.

```yaml
x-agent-env: &agent-env
  GITHUB_APP_ID:               ${GITHUB_APP_ID}
  GITHUB_APP_PRIVATE_KEY:      ${GITHUB_APP_PRIVATE_KEY}
  GITHUB_APP_INSTALLATION_ID:  ${GITHUB_APP_INSTALLATION_ID}
  GITHUB_USER:                 ${GITHUB_USER}
  ANTHROPIC_API_KEY:           ${ANTHROPIC_API_KEY}
  COORDINATOR_URL:             http://coordinator:8080
  LOG_LEVEL:                   info

services:
  coordinator:
    image: agentify/coordinator
    environment:
      GITHUB_APP_ID:              ${GITHUB_APP_ID}
      GITHUB_APP_PRIVATE_KEY:     ${GITHUB_APP_PRIVATE_KEY}
      GITHUB_APP_INSTALLATION_ID: ${GITHUB_APP_INSTALLATION_ID}
      GITHUB_USER:                ${GITHUB_USER}
      LOG_LEVEL:                  info
    volumes:
      - coordinator-data:/data
    ports: ["8080:8080"]   # for ops curl + TUI

  orchestrator:
    image: agentify/agent
    environment: { <<: *agent-env, AGENT_PUBLIC_URL: http://orchestrator:8080 }
    volumes:
      - ./souls/orchestrator.md:/etc/agentify/SOUL.md:ro
      - orchestrator-workspace:/workspaces
    depends_on: [coordinator]

  conductor:
    image: agentify/agent
    environment: { <<: *agent-env, AGENT_PUBLIC_URL: http://conductor:8080 }
    volumes:
      - ./souls/conductor.md:/etc/agentify/SOUL.md:ro
      - conductor-workspace:/workspaces
    depends_on: [coordinator]

  theorist:
    image: agentify/agent
    environment: { <<: *agent-env, AGENT_PUBLIC_URL: http://theorist:8080 }
    volumes:
      - ./souls/theorist.md:/etc/agentify/SOUL.md:ro
      - theorist-workspace:/workspaces
    depends_on: [coordinator]

  tinkerer:
    image: agentify/agent
    environment: { <<: *agent-env, AGENT_PUBLIC_URL: http://tinkerer:8080 }
    volumes:
      - ./souls/tinkerer.md:/etc/agentify/SOUL.md:ro
      - tinkerer-workspace:/workspaces
    depends_on: [coordinator]

  optimizer:
    image: agentify/agent
    environment: { <<: *agent-env, AGENT_PUBLIC_URL: http://optimizer:8080 }
    volumes:
      - ./souls/optimizer.md:/etc/agentify/SOUL.md:ro
      - optimizer-workspace:/workspaces
    depends_on: [coordinator]

  glue:
    image: agentify/agent
    environment: { <<: *agent-env, AGENT_PUBLIC_URL: http://glue:8080 }
    volumes:
      - ./souls/glue.md:/etc/agentify/SOUL.md:ro
      - glue-workspace:/workspaces
    depends_on: [coordinator]

  skeptic:
    image: agentify/agent
    environment: { <<: *agent-env, AGENT_PUBLIC_URL: http://skeptic:8080 }
    volumes:
      - ./souls/skeptic.md:/etc/agentify/SOUL.md:ro
      - skeptic-workspace:/workspaces
    depends_on: [coordinator]

  crafter:
    image: agentify/agent
    environment: { <<: *agent-env, AGENT_PUBLIC_URL: http://crafter:8080 }
    volumes:
      - ./souls/crafter.md:/etc/agentify/SOUL.md:ro
      - crafter-workspace:/workspaces
    depends_on: [coordinator]

  scribe:
    image: agentify/agent
    environment: { <<: *agent-env, AGENT_PUBLIC_URL: http://scribe:8080 }
    volumes:
      - ./souls/scribe.md:/etc/agentify/SOUL.md:ro
      - scribe-workspace:/workspaces
    depends_on: [coordinator]

volumes:
  coordinator-data:
  orchestrator-workspace:
  conductor-workspace:
  theorist-workspace:
  tinkerer-workspace:
  optimizer-workspace:
  glue-workspace:
  skeptic-workspace:
  crafter-workspace:
  scribe-workspace:
```

`docker compose up` runs the entire team pointing at every repo the GitHub App is installed on. The TUI (§17) runs **on the host**, not in compose, since it needs an interactive terminal.

### 16.2 Image strategy

A single `agentify/agent` image. Each running container is differentiated only by its `SOUL.md` mount and env. Same image rebuild applies to all agents.

## 17. TUI monitoring interface

A terminal dashboard for live observation and basic control of the running stack. Distributed as the package `@agentify/tui` and installable as a CLI binary `agentify`. The TUI is **read-mostly**: anything destructive (halt/resume, reset, kill job) requires a confirmation modal.

### 17.1 Distribution & invocation

```bash
# Install once
pnpm add -g @agentify/tui

# Run against the local stack
agentify tui                                     # defaults to http://localhost:8080
agentify tui --coordinator https://my-coord:8080
```

The TUI talks **only** to the coordinator HTTP API plus, for log streaming, directly to each agent's `/jobs/:id` and (optionally) `docker logs -f` if the host has docker socket access. No new server-side endpoints are required beyond what's already in §7 — except a small additive set for live data, listed in §17.4.

### 17.2 Stack

| Concern | Library |
|---|---|
| TUI framework | `ink` + `ink-spinner`, `ink-table`, `ink-text-input`, `ink-select-input` |
| Routing/keys  | a thin internal screen-router (no external dep) |
| HTTP client   | `undici` |
| State         | local `useReducer`-driven store; refresh on a 1s tick + on key events |
| Logs          | streaming via NDJSON SSE from coordinator's `/logs/stream` (see §17.4) |

Node 22+, runs on macOS / Linux terminals. Color-aware, falls back to monochrome when `NO_COLOR` is set or stdout isn't a TTY (in which case `agentify status` prints a one-shot snapshot and exits).

### 17.3 Screens

A single window with a left-side nav and a header showing connection state, halt status, and global counts. Bottom bar shows context-aware keybindings.

#### (1) Dashboard (default)

- **Header strip**: coordinator URL, halt status (red banner if halted), agent counts by status (IDLE / BUSY / FAILURE), open jobs count.
- **Agents grid**: rows = registered agents. Columns: emoji, persona, name, status, current job (`method @ repo#id`), elapsed, last error.
- **Recent jobs**: last 20 jobs with method, persona, repo, target, outcome, duration.

```
 agentify TUI · coordinator:http://localhost:8080 · 09:14:22Z   [HALT: off]
 ─────────────────────────────────────────────────────────────────────────
   IDLE 6   BUSY 2   FAILURE 1     OPEN JOBS 2     REPOS 4

  AGENTS
  🎯 orchestrator  orch-01      IDLE     —                                      —
  🎭 conductor     cond-01      IDLE     —                                      —
  🧠 theorist      theo-01      IDLE     —                                      —
  🔧 tinkerer      tink-01      BUSY     implement @ acme/api#412     2m12s     —
  ⚡ optimizer     opt-01       IDLE     —                                      —
  🔗 glue          glue-01      BUSY     address-review @ acme/api#398   55s    —
  🛡️ skeptic       skep-01      FAILURE  —                                      auth_failure 03m ago
  🎨 crafter       craft-01     IDLE     —                                      —
  📝 scribe        scrb-01      IDLE     —                                      —

  RECENT JOBS                                                              ↓ scroll
  ✅ plan            orchestrator   acme/api #410     1m44s   ok
  ✅ review          skeptic        acme/api #398     54s     changes_requested
  ❌ merge           conductor      acme/api #401     12s     task_error: dirty tree
  ...
 ─────────────────────────────────────────────────────────────────────────
 [d]ashboard  [a]gents  [j]obs  [r]epos  [l]ogs  [h]alt  [q]uit
```

#### (2) Agents

Sortable/filterable list of agents. Pressing `Enter` on a row drills in:

- Full SOUL summary (name, type, version, models per method, git identity).
- Live `/status`, last 10 jobs (link to job detail), last failure with stack.
- Actions: `R` reset (calls `POST /agents/:id/reset` → coordinator → agent), `K` kill current job (v1.1 stub).

#### (3) Jobs

Two tabs: **Open** (running/dispatched) and **Recent** (completed/failed, last 200). Filters: persona, method, repo, outcome.

Drill-in shows the full `JobResult`, structured logs (NDJSON tail), and a link to the GitHub issue/PR.

#### (4) Repos

Discovered repos with poll cadence, last-polled timestamp, and routable item counts (issues with `agent:*` routing labels, PRs in review, etc.). Action: `P` toggle active/inactive (calls `PATCH /repos/:repo`).

#### (5) Logs

Live NDJSON stream from `/logs/stream`. Filters: `agent_id`, `repo`, `level≥`. `/` opens a regex search over the visible buffer.

#### (6) Halt confirmation modal

`h` from any screen opens a confirm dialog. `y` calls `POST /halt`; `n` cancels. While halted, the header banner is red and `h` again calls `POST /resume`.

### 17.4 Coordinator additions for the TUI

Three additive endpoints (still polling-friendly), plus one SSE stream:

| Method | Path | Description |
|---|---|---|
| GET | `/agents/:id` | Full agent record (registration + last-known status, last 10 jobs). |
| POST | `/agents/:id/reset` | Coordinator forwards `POST /reset` to the agent and returns the result. |
| PATCH | `/repos/:owner/:name` | Body: `{ active?, poll_interval_s? }`. Persists in `repos` table. |
| GET | `/logs/stream` (SSE) | NDJSON event stream merged from all registered agents and the coordinator. Each event: `{ ts, level, agent_id?, job_id?, repo?, msg, ctx }`. Coordinator subscribes to each agent's `/logs/stream` (also SSE) and fans out. |

The agent gains a single new endpoint:

| Method | Path | Description |
|---|---|---|
| GET | `/logs/stream` (SSE) | NDJSON tail of the same pino-formatted lines that go to stdout. Coordinator is the only intended consumer. |

These endpoints are additive; the v1 core flows in §6 and §7 still work without them if the TUI is not deployed.

### 17.5 Auth

The TUI uses the same network-only trust model as the rest of the stack. When the coordinator port is exposed beyond `localhost`, operators are expected to front it with a reverse proxy that handles auth (out of scope for this spec).

### 17.6 Non-TUI fallback

`agentify status` prints a one-shot, ANSI-free snapshot of the dashboard view — useful for SSH sessions, CI tooling, and pipes:

```bash
$ agentify status --coordinator http://localhost:8080
HALT: off
AGENTS  IDLE=6 BUSY=2 FAILURE=1
JOBS    OPEN=2  RECENT=20
…
```

Equivalent JSON via `agentify status --json` for shell scripts.

## 18. Tech stack

| Concern | Library |
|---|---|
| HTTP server | `fastify` + `@fastify/sensible` |
| Schema validation | `zod` (+ `fastify-type-provider-zod`) |
| GitHub | `@octokit/rest`, `@octokit/auth-app` |
| Claude | `@anthropic-ai/claude-agent-sdk` (formerly `@anthropic-ai/claude-code`; renamed May 2026) |
| DB (coordinator) | `better-sqlite3` |
| Logging | `pino` |
| Metrics | `prom-client` |
| TUI | `ink` + `ink-*` components, `undici` |
| Testing | `vitest`, `nock`/`msw` for GitHub mocking, `ink-testing-library` for TUI |
| Build | `tsc`, `pnpm` workspace, multi-stage Dockerfile |
| Lint/format | `eslint`, `prettier` |

### Repo layout

```
agenti-fy/
├── packages/
│   ├── shared/         # zod schemas, types shared between all services
│   ├── agent/          # @agentify/agent service
│   │   ├── src/
│   │   │   ├── api/    # fastify routes
│   │   │   ├── soul/   # SOUL.md parser
│   │   │   ├── skills/ # default skill prompts (md)
│   │   │   ├── claude/ # Claude Code SDK adapter
│   │   │   ├── git/    # worktree manager, octokit wrapper
│   │   │   └── index.ts
│   │   └── Dockerfile
│   ├── coordinator/    # @agentify/coordinator service
│   │   ├── src/
│   │   │   ├── api/    # fastify routes
│   │   │   ├── poller/ # GitHub poll loop
│   │   │   ├── store/  # better-sqlite3 access
│   │   │   ├── dispatch/
│   │   │   ├── logs/   # SSE fan-out for TUI
│   │   │   └── index.ts
│   │   └── Dockerfile
│   └── tui/            # @agentify/tui — ink-based monitoring CLI
│       ├── src/
│       │   ├── screens/   # dashboard, agents, jobs, repos, logs
│       │   ├── components/
│       │   ├── store/     # client-side state
│       │   ├── api/       # undici-based coordinator client
│       │   └── index.ts
│       └── package.json
├── personas/           # bundled default persona bodies (orchestrator.md, conductor.md, …)
├── souls/              # example SOUL.md files for each of the 9 personas
├── docker-compose.yml
├── pnpm-workspace.yaml
└── tsconfig.json
```

## 19. Non-goals (v1)

- Multi-tenant / multi-installation in a single deployment.
- Auto-scaling. Agents are statically declared in compose.
- Persistent durable queue. Lost in-flight is recovered via GitHub labels, not a queue.
- Knowledge base / cross-project memory beyond the per-(agent,repo) Claude session id.
- Web UI dashboard. The terminal TUI (§17) is the only operator interface; no browser frontend in v1.
- Webhook from GitHub OR from agent to coordinator. Polling everywhere.
- Rate limiter. Polling at default cadence with one App installation is well below limits; revisit if needed.

## 20. Open questions

1. **Stale `*-in-progress` recovery**: should the agent persist current label transitions to disk so a crashed container can rollback its labels on restart, instead of relying solely on the coordinator's stale-job sweeper? (Probably v1.1.)
2. **PR base branch**: assumed `main`. If a repo uses `master`/`develop`, it must be configurable per-repo (today: nothing; needed soon).
3. **Plan re-run**: if a planner is invoked on an already-planned parent issue, should it append, replace, or refuse? Current spec implicitly refuses — coordinator only dispatches when `agent:<persona>:plan` is present, and the planner removes it on completion.
4. ~~**Conflict resolution in Merge**~~: resolved — the Merge skill performs full semantic conflict resolution (read both sides, reconstruct intent, run tests, force-push with lease). `needs-human` is the fallback only when the conflict requires product/business judgment or tests fail in a way that needs out-of-scope changes. Conductor's `merge` model is sized accordingly (sonnet, not haiku).
5. **Cost / token caps** per job? Not in v1 — operator monitors via Prometheus counters and the TUI.
6. **Persona availability when planning**: the planner's prompt needs an up-to-date roster of registered personas (so it doesn't label a child for a persona that isn't running). Inject via `/agents` snapshot at job start, vs. let it discover via failed dispatches?

## 21. Implementation phases

1. **Skeleton** — pnpm workspace, three packages (`shared`, `agent`, `coordinator`), zod schemas, fastify scaffolding, healthchecks, register/heartbeat.
2. **Coordinator core** — SQLite, App-installation repo discovery, poll loop, combined-label dispatch (`agent:<persona>:<method>`), halt mechanism.
3. **Agent core** — SOUL.md parser (with bundled persona fallback), Claude Code SDK adapter, worktree manager, session pull/push to coordinator.
4. **Skills & personas** — default `plan/implement/review/address-review/merge` skill prompts; bundled persona bodies for all nine built-ins; SOUL inline overrides.
5. **End-to-end** — first run against a sandbox GitHub repo with the full nine-agent team.
6. **Observability** — Prometheus, pino logs, `/jobs/:id`, SSE log stream.
7. **TUI** — `@agentify/tui` package: dashboard, agents, jobs, repos, logs screens; halt confirmation; non-TTY `agentify status` fallback.
8. **Polish** — `/reset`, stale-job sweeper, halt label, docs.

---

*Spec v0.1.0 — captured from interview on 2026-05-02. Predecessor reference: `../agenti-fi`.*
