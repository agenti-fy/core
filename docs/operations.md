# Operations playbook

Operator reference for agenti-fy. Commands are written to run against the default Docker Compose deployment (`coordinator` at `http://localhost:8080`; substitute your actual host/port). Assumes no auth wrapper in front of the HTTP surface — deploy behind one in production.

---

## Contents

- [Halt and resume](#halt-and-resume)
- [Stuck job detection](#stuck-job-detection)
- [Failure outcomes](#failure-outcomes)
- [Resetting an agent](#resetting-an-agent)
- [Re-routing a stuck issue](#re-routing-a-stuck-issue)
- [Reading the SSE log stream](#reading-the-sse-log-stream)
- [Prometheus metrics](#prometheus-metrics)
- [Database surgery (last resort)](#database-surgery-last-resort)

---

## Halt and resume

Three mechanisms halt the coordinator. All three set the same sticky flag in the coordinator's SQLite `control` table.

| Mechanism | Command / action |
|-----------|-----------------|
| HTTP | `curl -X POST http://localhost:8080/halt` |
| HTTP (canonical) | `curl -X PUT http://localhost:8080/control/halt -H 'Content-Type: application/json' -d '{"halted":true}'` |
| GitHub label | Apply `halt-agents` to any issue or PR in any watched repo |
| TUI | Press `h` |

**Sticky behaviour.** Halt does NOT auto-clear when the `halt-agents` label is removed. The work-poller uses a `since=` filter that can miss the label removal if the coordinator was already halted when the removal happened. Always resume explicitly:

```sh
curl -X POST http://localhost:8080/resume
# or
curl -X PUT http://localhost:8080/control/halt \
  -H 'Content-Type: application/json' \
  -d '{"halted":false}'
```

The rationale is in `packages/coordinator/src/poller/work-poller.ts`: the `since=` window only returns issues whose `updated_at` moved, so a label removal on an otherwise-quiet issue may be invisible until the next periodic full scan.

**Check halt state:**

```sh
curl -s http://localhost:8080/control/halt
# {"halted":false}
```

**What halting does and does NOT do.** A halted coordinator stops dispatching new work and stops writing `*-in-progress` labels. In-flight jobs already running on agents continue uninterrupted. Agents are not notified — they keep their current job and will heartbeat normally.

---

## Stuck job detection

The stale-sweeper (`packages/coordinator/src/poller/stale-sweeper.ts`) finds issues with an `agent:<persona>:<method>-in-progress` label whose `updated_at` is older than the timeout AND for which there is no active job in the coordinator's DB. This typically means the agent crashed or was deleted mid-run. The sweeper removes the stuck marker and restores the routing label so the work-poller re-dispatches on the next tick.

**Configuration:**

| Variable | Default | Meaning |
|----------|---------|---------|
| `STALE_JOB_TIMEOUT_S` | `1800` (30 min) | Label age threshold for a stuck marker |
| `STALE_JOB_SWEEP_S` | `600` (10 min) | How often the sweeper runs |

**Per-persona scoped.** Each `(persona, method)` marker is swept independently. If conductor's review is stuck and skeptic's review is in-flight on the same PR, only conductor's marker is cleared.

**Diagnosing a `*-in-progress` label that never cleared:**

```sh
# 1. Confirm the coordinator sees it as stuck (log line to look for):
curl -N http://localhost:8080/logs/stream | grep 'sweeping stale'

# 2. Check if there is an active job in the coordinator DB:
curl -s http://localhost:8080/jobs?status=open | jq '.[] | select(.repo=="owner/repo")'

# 3. Check the agent's live status:
AGENT_ID=$(curl -s http://localhost:8080/agents | jq -r '.[0].agent_id')
curl -s http://localhost:8080/agents/$AGENT_ID
```

If the agent is gone or in FAILURE, the sweeper will clear the label within `STALE_JOB_SWEEP_S` seconds once the timeout has elapsed. To clear immediately: remove the in-progress label manually on GitHub and re-apply the routing label.

---

## Failure outcomes

All outcomes are stored in the `jobs` table. The coordinator also emits a structured log line `job completed` with `outcome`, `method`, `repo`, and `duration_ms`.

| Outcome | Typical cause | Where to look | Recovery |
|---------|--------------|---------------|----------|
| `success` | Skill completed without error | — | None |
| `task_error` | Skill returned an error, `CLAUDE_TIMEOUT_MS` was hit, or `CLAUDE_COST_LIMIT_USD` ceiling was exceeded | Comment posted on the issue/PR; `GET /agents/:id/jobs` | Remove `needs-human`, re-apply routing label |
| `orphaned` | Agent restarted mid-run (job was dispatched but agent has no record of it) | Coordinator logs: `agent has no record of our job — orphaned` | Remove any stale `*-in-progress` label on GitHub; re-apply routing label |
| `sdk_failure` | Claude SDK threw an unhandled exception | Agent logs; `GET /agents/:id` → `last_known_status: FAILURE` | Fix the cause (API key, network); `POST /agents/:id/reset` |
| `auth_failure` | 401/403 from Anthropic API or GitHub | Agent logs; comment on issue/PR | Fix credentials; `POST /agents/:id/reset` |
| `config_failure` | Worktree prep failed, missing env var, SOUL.md parse error | Agent logs; `GET /status` on the agent directly | Fix the env or SOUL.md; `POST /agents/:id/reset` |

For `task_error`, `sdk_failure`, `auth_failure`, and `config_failure`: the agent applies the `needs-human` label to the target and posts a comment with the error message. The target stays out of routing until `needs-human` is manually removed.

**Get the error detail from the coordinator DB:**

```sh
curl -s 'http://localhost:8080/jobs?status=recent&limit=20' \
  | jq '.[] | select(.outcome != "success") | {job_id, outcome, result_json}'
```

---

## Resetting an agent

`POST /agents/:id/reset` tells the coordinator to proxy a `/reset` call to the agent. The agent reloads its SOUL.md, re-validates environment, and re-registers with the coordinator. Use this to clear a `FAILURE` state after fixing the underlying cause, or to hot-swap a SOUL.md without restarting the container.

```sh
# List agents and find the one you want to reset
curl -s http://localhost:8080/agents | jq '.[] | {agent_id, name, last_known_status}'

# Reset it
curl -X POST http://localhost:8080/agents/<agent_id>/reset
```

**Responses:**

| Status | Body | Meaning |
|--------|------|---------|
| 200 | `{"ok":true,"agent_status":{...}}` | Success. Agent is now IDLE. |
| 409 | `{"ok":false,"agent_status_code":409,"body":{"error":"BUSY","current_job_id":"..."}}` | Agent is running a job. Wait for it to complete or kill the container. Mid-flight SOUL swap is refused because git commits and comment signatures would use different identities. |
| 503 | `{"ok":false,"agent_status_code":503,"body":{"error":"INIT_FAILED","last_failure":{...}}}` | Re-init failed. Fix the reported issue and retry. |
| 404 | — | Agent ID not registered. Check `curl http://localhost:8080/agents`. |

After a successful reset the coordinator records `IDLE` in its `agents` table immediately, before the agent's next heartbeat, so dispatch can resume without waiting up to `HEARTBEAT_INTERVAL_MS`.

---

## Re-routing a stuck issue

Issues can get stuck in three ways:

**1. Blocked by `needs-human`**

```sh
# On GitHub: remove the `needs-human` label from the issue/PR.
# Then re-apply the routing label, e.g.:
gh issue edit <number> -R owner/repo \
  --remove-label "needs-human" \
  --add-label "agent:tinkerer:implement"
```

**2. Stale `*-in-progress` label (agent died mid-run)**

The stale-sweeper will restore the routing label automatically once `STALE_JOB_TIMEOUT_S` has elapsed. To restore it immediately:

```sh
gh issue edit <number> -R owner/repo \
  --remove-label "agent:tinkerer:implement-in-progress" \
  --add-label "agent:tinkerer:implement"
```

**3. Dep-blocked (a dependency issue is still open)**

The work-poller skips issues where `Depends on: #N` resolves to an open issue. Close or remove the dependency reference, then the poller re-evaluates on the next tick or full-scan cycle (at most `FULL_SCAN_INTERVAL_MS = 10 min`).

---

## Reading the SSE log stream

Both coordinator and each agent expose a Server-Sent Events stream of structured (pino-format) JSON log lines.

**Coordinator stream** (aggregates coordinator + all agent log events):

```sh
# Tail live + replay last 100 events on connect
curl -N http://localhost:8080/logs/stream

# Live only (skip replay — useful on reconnect to avoid duplicates)
curl -N http://localhost:8080/logs/stream?live=1
```

**Agent stream** (replay last 50):

```sh
curl -N http://localhost:<agent-port>/logs/stream
curl -N http://localhost:<agent-port>/logs/stream?live=1
```

**Filtering with `jq`:**

```sh
# Show only WARN and above
curl -N http://localhost:8080/logs/stream \
  | grep '^data:' | sed 's/^data: //' \
  | jq 'select(.level >= 40)'

# Follow a specific agent
curl -N http://localhost:8080/logs/stream \
  | grep '^data:' | sed 's/^data: //' \
  | jq 'select(.agent_id == "<your-agent-id>")'
```

Log levels follow pino conventions: `10` trace, `20` debug, `30` info, `40` warn, `50` error, `60` fatal. Set `LOG_LEVEL` on each container to control verbosity.

---

## Prometheus metrics

Both services expose `/metrics` in Prometheus text format.

### Coordinator — `http://localhost:8080/metrics`

Source: `packages/coordinator/src/metrics.ts`

| Metric | Labels | Description |
|--------|--------|-------------|
| `agentify_jobs_total` | `method`, `outcome` | Total jobs by method and final outcome |
| `agentify_dispatched_total` | `method`, `kind` | Dispatch attempts. `kind`: `accepted`, `busy`, `failure`, `method_not_supported`, `rejected`, `transport_error` |
| `agentify_dispatch_latency_ms` | `method`, `kind` | Coordinator→agent POST round-trip latency (buckets: 5 ms – 10 s) |
| `agentify_coordinator_*` | — | Default prom-client process / Node.js metrics |

### Agent — `http://localhost:<agent-port>/metrics`

Source: `packages/agent/src/metrics.ts`. All metrics carry a `persona` default label set to the agent's soul name.

| Metric | Labels | Description |
|--------|--------|-------------|
| `agentify_jobs_total` | `method`, `outcome` | Skill runs by method and outcome |
| `agentify_job_duration_ms` | `method`, `outcome` | Wall-clock skill duration (buckets: 100 ms – 20 min) |
| `agentify_claude_tokens_total` | `kind` | Claude SDK tokens consumed. `kind`: `input`, `output`, `cache_read`, `cache_write` |
| `agentify_claude_cost_usd_total` | `method` | Cumulative USD cost by method |
| `agentify_agent_*` | — | Default prom-client process / Node.js metrics |

### Scrape config snippet

```yaml
scrape_configs:
  - job_name: agentify-coordinator
    static_configs:
      - targets: ['coordinator:8080']
  - job_name: agentify-agent
    static_configs:
      - targets: ['agent-tinkerer:8080', 'agent-skeptic:8080']  # add one per agent
```

### Useful queries

```promql
# Dispatch acceptance rate
sum(rate(agentify_dispatched_total{kind="accepted"}[5m]))
  / sum(rate(agentify_dispatched_total[5m]))

# Job error rate across all methods
sum(rate(agentify_jobs_total{outcome!="success"}[5m]))
  / sum(rate(agentify_jobs_total[5m]))

# P95 skill duration per method
histogram_quantile(0.95, sum by (method, le)(rate(agentify_job_duration_ms_bucket[30m])))

# Cumulative Claude cost per persona
agentify_claude_cost_usd_total
```

---

## Database surgery (last resort)

The coordinator stores all state in a single SQLite file.

**Location:** `$DATA_DIR/coordinator.db` (default `/data/coordinator.db` inside the coordinator container).

**WAL mode is on.** There will be companion files `coordinator.db-wal` and `coordinator.db-shm` while the coordinator is running. Do not copy the `.db` file alone for backup — copy all three together, or use `.backup` via the SQLite CLI.

**What is safe to read while the coordinator is running:**

```sh
# Exec into the coordinator container (or mount the volume)
sqlite3 /data/coordinator.db

-- List registered agents
SELECT agent_id, name, last_known_status, datetime(last_heartbeat/1000,'unixepoch') FROM agents;

-- Open jobs
SELECT job_id, method, repo, target_id, persona_name, status, dispatched_at FROM jobs
  WHERE status IN ('dispatched','running');

-- Recent failures
SELECT job_id, method, outcome, result_json FROM jobs
  WHERE outcome NOT IN ('success') AND completed_at IS NOT NULL
  ORDER BY completed_at DESC LIMIT 20;

-- Halt flag
SELECT value FROM control WHERE key='halted';

-- Dep-blocked targets
SELECT repo, target_id, datetime(blocked_at/1000,'unixepoch') as blocked_since FROM dep_blocked;
```

**What is NOT safe to mutate live:**

Do not `UPDATE`, `INSERT`, or `DELETE` rows while the coordinator is running. The coordinator caches prepared statements and holds its own WAL write lock. Concurrent writes from `sqlite3` will produce either a `SQLITE_BUSY` error or, if you force through, a torn state that the coordinator cannot reconcile. If you must repair rows: stop the coordinator first (`docker compose stop coordinator`), make the change, verify with `PRAGMA integrity_check;`, then restart.

The one safe live mutation is setting the halt flag — but use the HTTP API for that (`POST /halt`) rather than touching the DB directly.
