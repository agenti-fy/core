# @agentify/coordinator

> Internals reference. For system-level architecture, routing labels, and operating instructions see the [root README](../../README.md).

## Contents

- [Purpose](#purpose)
- [Entry point](#entry-point)
- [Subsystems](#subsystems)
- [SQLite schema](#sqlite-schema)
- [HTTP routes](#http-routes)
- [Polling model](#polling-model)
- [Local dev](#local-dev)

---

## Purpose

The coordinator is the control plane of the agenti-fy system. It polls GitHub for labelled issues and PRs, evaluates routing rules, and dispatches jobs to registered agent containers over HTTP. It owns all durable state — which agents exist, which jobs are running or complete, which repos are being watched, and whether the system is halted — in a local SQLite database, and exposes that state through a REST API consumed by the TUI and operators.

---

## Entry point

`src/index.ts` bootstraps in this order:

1. Parse config (`src/config.ts`) from environment variables.
2. Open the SQLite store and run pending migrations (`src/store.ts`).
3. Build the GitHub App Octokit client (`src/github/client.ts`) unless `DISABLE_GITHUB=true`.
4. Instantiate agent RPC client and Prometheus metrics (`src/metrics.ts`).
5. Register Fastify server with all route plugins (`src/server.ts`).
6. Listen on `HOST:PORT`.
7. Start the runtime — pollers, log-forwarder, stale-sweeper (`src/runtime.ts`).
8. Run halt-label preflight (`src/github/halt-preflight.ts`).

Graceful shutdown drains open connections with a 30 s timeout.

---

## Subsystems

### `src/store.ts`

WAL-mode SQLite via `better-sqlite3`. Owns all schema definitions, migration runner, and every prepared statement. Nothing outside this file writes to the database directly. Exports typed functions (`upsertAgent`, `insertJob`, `completeJob`, etc.) consumed by pollers, dispatcher, and route handlers.

### `src/dispatch/index.ts`

`dispatchBatch()` receives a list of pending work items from the work-poller. For each item it:

1. Skips if the halt flag is set.
2. Checks for an already-active job on the same `(repo, persona_name, method, target_id)`.
3. Picks an idle agent whose `type` matches the persona and whose `supported_methods` includes the method.
4. Marks the agent BUSY, inserts a `jobs` row with `status='dispatched'`, and POSTs to `agent_url/<method>`.
5. Records the outcome: `202 accepted` → `running`; `4xx rejected` → `failed_to_dispatch` (agent reverts to idle); transport error → stays `dispatched` for the completion-poller to reconcile.

Items for the same repo are serialised; items across repos run in parallel.

### `src/poller/`

Five poller modules, all started by `src/runtime.ts`:

| File | Role |
|---|---|
| `work-poller.ts` | Scans repos due for polling; evaluates routing labels and `Depends on:` dependency gates; writes pending items to `dep_blocked` when blocked; feeds `dispatchBatch` |
| `job-poller.ts` | Polls each registered agent's `/status` endpoint; detects BUSY→IDLE transitions; persists job outcomes and `session_id` on completion |
| `pr-monitor.ts` | Walks open PRs; applies deterministic routing labels based on GitHub review state (CHANGES_REQUESTED → `address-review`, all-approved → `merge`, otherwise reviewer labels) |
| `stale-sweeper.ts` | Finds issues with stuck in-progress labels (no active job in DB, age > `STALE_JOB_TIMEOUT_S`); restores routing labels so the work-poller re-dispatches |
| `log-forwarder.ts` | Subscribes to each agent's `/logs/stream` SSE endpoint; republishes on the coordinator log bus; reconnects with exponential backoff (base 1.5 s, cap 30 s) |

### `src/github/`

| File | Role |
|---|---|
| `client.ts` | Builds the authenticated Octokit instance (GitHub App credentials); injects a 30 s per-request timeout |
| `discover.ts` | Refreshes the `repos` table from the GitHub App installation access list; adds new repos as active, deactivates inaccessible ones, preserves `poll_interval_s` |
| `halt-preflight.ts` | One-shot GitHub label search at startup; catches halt states on issues that were not updated since the last poll tick (non-fatal on failure) |

### `src/routes/`

Fastify route plugins registered in `src/server.ts`. See [HTTP routes](#http-routes).

---

## SQLite schema

Defined in `src/store.ts`; applied by a numbered migration runner. The database lives at `$DATA_DIR/coordinator.db` (default `/data/coordinator.db`).

| Table | `store.ts` lines | What it holds | Cascade |
|---|---|---|---|
| `agents` | 46–56 | Registered agent identity, URL, persona type, supported methods, heartbeat, last-known status | — |
| `sessions` | 58–64 | Active Claude Code `session_id` per `(agent_id, repo)` pair; updated on successful job completion | `ON DELETE CASCADE` from `agents` |
| `jobs` | 66–77 | Every dispatched job: method, repo, target issue/PR number, persona name, status, outcome, result JSON, timestamps | — |
| `repos` | 86–91 | Repos under management: per-repo poll interval, active flag, last-polled timestamp | — |
| `control` | 93–97 | Key/value operational state; currently used for the `halted` flag | — |
| `dep_blocked` | 193–199 | Issues skipped because a declared `Depends on:` reference is still open; re-evaluated each poll tick | — |
| `schema_migrations` | 237–241 | Migration log: id, name, `applied_at` timestamp | — |

Key indices on `jobs`:
- Partial unique index on `(repo, persona_name, method, target_id) WHERE status IN ('dispatched','running')` — prevents double-dispatch.
- `jobs_by_agent (agent_id, status)` — serves agent-scoped job lookups.
- `jobs_by_completed_at (completed_at)` — serves GC queries on completed/failed rows.
- `jobs_agent_dispatched (agent_id, dispatched_at DESC)` — covers `pickIdleAgent`'s MAX aggregation.
- `jobs_failed_dispatch (dispatched_at) WHERE status='failed_to_dispatch'` — serves GC on failed-dispatch rows.

---

## HTTP routes

| File | Endpoints |
|---|---|
| `src/routes/agents.ts` | `POST /agents/register` · `GET /agents` · `GET /agents/:id` · `POST /agents/:id/heartbeat` · `GET /agents/:id/jobs` · `DELETE /agents/:id` · `POST /agents/:id/reset` |
| `src/routes/jobs.ts` | `GET /jobs?status=open\|recent\|all&limit=N` |
| `src/routes/repos.ts` | `GET /repos` · `PATCH /repos/:owner/:name` (set `active`, `poll_interval_s`) |
| `src/routes/sessions.ts` | `GET /sessions/:agent_id/:org/:repo` · `PUT /sessions/:agent_id/:org/:repo` |
| `src/routes/control.ts` | `GET /control/halt` · `PUT /control/halt` · `POST /halt` · `POST /resume` |
| `src/routes/health.ts` | `GET /health` — returns `{ok, service, version, uptime_s}` |
| `src/routes/logs.ts` | `GET /logs/stream` — SSE stream of coordinator log entries |
| `src/routes/metrics.ts` | `GET /metrics` — Prometheus text format |

---

## Polling model

All intervals are env vars resolved in `src/config.ts` (lines 19–45).

| Env var | Default | Cadence source | What fires |
|---|---|---|---|
| `WORK_POLL_S` | `30` s | `src/config.ts:22` | Scan repos for new routing labels; feed `dispatchBatch` |
| `JOB_COMPLETION_POLL_S` | `5` s | `src/config.ts:21` | Check each running job's agent `/status` for completion |
| `INSTALLATION_REFRESH_S` | `300` s | `src/config.ts:20` | Refresh `repos` table from GitHub App installation |
| `STALE_JOB_SWEEP_S` | `600` s | `src/config.ts:38` | Sweep stuck in-progress labels; restore routing |
| `MAX_RESULT_JSON_BYTES` | `262144` | `src/config.ts:77` | Hard cap on serialized `result_json`; oversize results become `task_error` with `artifacts: {}` |
| `PR_MONITOR_INTERVAL_S` | `30` s | `src/config.ts:45` | Walk open PRs; apply reviewer/action routing labels |
| `PLAN_COMPLETION_POLL_S` | `60` s | `src/config.ts:44` | Walk open plans; update parent checklists; close completed parents |

`DEFAULT_POLL_INTERVAL_S` (default `30`) sets `repos.poll_interval_s` when a repo is first discovered. Individual repos can be tuned via `PATCH /repos/:owner/:name`.

`STALE_JOB_TIMEOUT_S` (default `1800`) controls how old an in-progress label must be before the sweeper acts on it.

`MAX_RESULT_JSON_BYTES` (default `262144`) sets the upper bound on the serialized job result persisted to `jobs.result_json`. When a result exceeds this limit the coordinator records the job as `task_error`, replaces `artifacts` with `{}`, and logs a warning with `serialized_bytes` and `cap` fields for triage.

---

## Local dev

```bash
# Watch mode: tsc --watch + node --watch
pnpm --filter @agentify/coordinator dev

# Type-check only
pnpm --filter @agentify/coordinator typecheck
```

**Required env vars** (GitHub-enabled mode):

```
GITHUB_APP_ID=<app-id>
GITHUB_APP_PRIVATE_KEY=<pem-contents>   # literal newlines, not \n
GITHUB_APP_INSTALLATION_ID=<install-id>
GITHUB_USER=<bot-username>
DATA_DIR=/tmp/coordinator-dev
```

Set `DISABLE_GITHUB=true` to skip GitHub auth; pollers that require GitHub (work-poller, repo-discover, pr-monitor) will not start.

**Smoke test** (`src/__smoke__/dispatch-roundtrip.ts`) — verifies the dispatch → completion-poller round-trip end-to-end. Requires a running coordinator with at least one registered agent:

```bash
DATA_DIR=/tmp/coordinator-dev \
DISABLE_GITHUB=1 \
AGENT_URL=http://localhost:3001 \
npx tsx packages/coordinator/src/__smoke__/dispatch-roundtrip.ts
```

The smoke test exits non-zero on failure. It does not require real GitHub credentials when `DISABLE_GITHUB=1`.
