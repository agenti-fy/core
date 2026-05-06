# agenti-fy

A multi-agent software development system. Each **agent** is an HTTP service driven by the Claude Code SDK that picks up GitHub issues and PRs, runs in a per-job worktree, and pushes changes back. A thin **coordinator** polls GitHub, owns the routing state, and dispatches work.

```
                ┌──────────────────────────────────────┐
                │              GitHub                  │
                │  (issues, PRs, labels, reviews)      │
                └────────────────┬─────────────────────┘
                                 │ Octokit (GitHub App)
                                 ▼
        ┌────────────────────────────────────────┐
        │          coordinator (container)       │
        │  · polls GitHub every N s              │
        │  · owns SQLite (sessions, jobs, repos) │
        │  · dispatches via HTTP to agents       │
        └──────────┬───────────────┬─────────────┘
                   │ HTTP RPC      │ HTTP RPC
                   ▼               ▼
        ┌──────────────────┐  ┌──────────────────┐
        │   agent #1       │  │   agent #2       │ …
        │   SOUL.md mount  │  │   SOUL.md mount  │
        │   Claude Code SDK│  │   Claude Code SDK│
        │   /workspaces vol│  │   /workspaces vol│
        └──────────────────┘  └──────────────────┘
```

The system has no auth/authz on its own HTTP surface — deploy on a private network or behind a reverse proxy.

See [CHANGELOG.md](./CHANGELOG.md) for release history.

## Contents

- [Security considerations](#security-considerations)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
  - [Routing labels](#routing-labels)
  - [Methods (skills)](#methods-skills)
  - [Built-in personas](#built-in-personas)
  - [Halt and recovery](#halt-and-recovery)
- [Configuration](#configuration)
  - [GitHub App setup](#github-app-setup)
  - [Anthropic API key](#anthropic-api-key)
  - [Coordinator env](#coordinator-env)
  - [Agent env](#agent-env)
- [Tuning for token cost](#tuning-for-token-cost)
- [SOUL.md format](#soulmd-format)
- [Operating](#operating)
  - [TUI](#tui)
  - [HTTP API](#http-api)
  - [Logs and metrics](#logs-and-metrics)
- [Development](#development)
- [Reference](#reference)

## Security considerations

Every GitHub field that a non-agent user can write — issue and PR titles, bodies, labels, review comments, diff text — is **untrusted attacker input**. The system is hardened against two attack classes:

- **Persona-label shell injection.** Three independent validation layers (`parseRoutingLabel` in `packages/shared/src/labels.ts`, `PersonaNameSchema` in `packages/shared/src/personas.ts`, and a fail-closed check in `packages/agent/src/skills/resolver.ts`) ensure that the persona name extracted from an `agent:<persona>:<method>` label can never contain shell metacharacters before it reaches a skill prompt.
- **Prompt injection via issue/PR text.** A coordinator-side hijack detector (`packages/coordinator/src/security/hijack-detector.ts`) screens issue bodies for known injection patterns before dispatching work; bodies that match are routed to `needs-human` instead. A `SECURITY_PREAMBLE` prepended to every agent system prompt instructs Claude that `gh issue view` / `gh pr view` / `gh pr diff` output is DATA, not an instruction extension.

Neither the hijack detector nor the security preamble is a hard boundary — they raise the cost of an attack, they do not make it impossible. The known residual gap (diff code-comment injection) is documented in [SPEC.md §22](./SPEC.md#22-security-model).

**Operator responsibilities:**

- **Scope the GitHub App installation.** Install the App only on repositories you intend to automate. Every repo in the installation list is part of the attack surface; audit it periodically via the App's installation settings.
- **Restrict who can interact with watched issues and PRs.** Anyone who can open issues or post comments in a managed repo can attempt injection. Use GitHub's interaction limits, branch protection rules, or a dedicated sandbox organisation to reduce exposure from untrusted contributors.
- **Monitor `agentify_coordinator_hijack_attempts_total`.** This Prometheus counter (labelled `{repo, pattern}`) increments each time the hijack detector diverts an issue to `needs-human`. A spike indicates active probing; a sustained zero does not mean the repo is clean — it means no pattern matched.
- **Review `needs-human` issues promptly.** Both task failures and hijack detections land on this label. An unreviewed `needs-human` stalls the workflow; a confirmed injection attempt should be reported and the author blocked via GitHub's abuse tooling.

For the full threat model — trust zones, validation contract, prompt-injection mitigations, known residuals, and the operator remediation playbook — see [SPEC.md §22 Security model](./SPEC.md#22-security-model).

## Quick start

The fastest path is Docker Compose with three sample personas.

### Prerequisites

- Docker + Docker Compose
- A GitHub App installed on your sandbox repo (see [GitHub App setup](#github-app-setup))
- An Anthropic API key

### Run

```sh
# 1. Set required env (or put them in a .env file next to docker-compose.yml)
export GITHUB_APP_ID=...
export GITHUB_APP_PRIVATE_KEY="$(cat path/to/key.pem)"   # multi-line PEM is fine
export GITHUB_APP_INSTALLATION_ID=...
export GITHUB_USER=your-bot-user
export ANTHROPIC_API_KEY=sk-ant-...

# 2. Start coordinator + one agent per built-in persona
#    (orchestrator, conductor, theorist, tinkerer, optimizer,
#     glue, skeptic, crafter, scribe)
docker compose up -d --build

# 3. Watch the dashboard
pnpm --filter @agentify/tui start
#   or, after building once:
node packages/tui/dist/index.js
```

That's it. Open an issue in the sandbox repo, label it `agent:tinkerer:plan`, and the orchestrator (or whichever agent matches) will pick it up within `WORK_POLL_S` seconds.

### Verify it's working

```sh
# Coordinator is up
curl -s http://localhost:8080/health

# Agents have registered
curl -s http://localhost:8080/agents | jq

# Watch the live log stream
curl -N http://localhost:8080/logs/stream
```

## How it works

### Routing labels

Work is dispatched purely by GitHub labels. Apply a single combined label to an issue or PR:

| Label                                  | Meaning                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| `agent:<persona>:<method>`             | Route to `<persona>` using `<method>` (e.g. `agent:tinkerer:plan`) |
| `agent:<persona>:<method>-in-progress` | Set by the agent on accept; cleared on completion             |
| `needs-human`                          | Operator escape hatch — takes the item out of routing         |
| `halt-agents`                          | Set anywhere to halt the entire coordinator                   |

The combined `agent:<persona>:<method>` format lets a single issue or PR carry multiple routing labels simultaneously — e.g. `agent:conductor:review` AND `agent:skeptic:review` — and each evolves independently. (The previous two-label scheme — `agent:<persona>` plus `task:<method>` — made this impossible: the first agent to pick up the item would remove the shared `task:review` label and the second would never see it.)

The work-poller scans active repos every `WORK_POLL_S` seconds. For each open issue/PR carrying an `agent:<persona>:<method>` label (and no `needs-human`, no matching `<persona>:<method>-in-progress` marker), it picks an idle agent for that persona and dispatches.

### Methods (skills)

| Method           | Label                              | Purpose                                                |
| ---------------- | ---------------------------------- | ------------------------------------------------------ |
| `plan`           | `agent:<persona>:plan`             | Read an issue, break it into child issues w/ checklist |
| `implement`      | `agent:<persona>:implement`        | Open a PR for an issue                                 |
| `review`         | `agent:<persona>:review`           | Review a PR (approve / changes / comment)              |
| `address_review` | `agent:<persona>:address-review`   | Push commits answering review feedback                 |
| `merge`          | `agent:<persona>:merge`            | Merge an approved PR                                   |

The method slug uses kebab-case where the enum uses snake_case (`address_review` → `address-review`).

The skill prompts are bundled defaults at `packages/agent/src/skills/defaults/*.md`. A persona's SOUL.md can override any of them with `## Skill: <method>` sections.

### Built-in personas

Each comes with default prompt, git identity, signature, and emoji:

`orchestrator`, `conductor`, `theorist`, `tinkerer`, `optimizer`, `glue`, `skeptic`, `crafter`, `scribe`

Plus `custom` for fully bespoke souls (uses the soul's `name` to match against the `agent:<name>` label).

The repo ships a SOUL.md per built-in at `souls/*.md`. The default `docker-compose.yml` runs **one container per built-in** — routing depends on a full lineup since different methods are handled by different personas (e.g. `orchestrator` plans, `tinkerer` implements, `skeptic` reviews). Removing a persona from the compose file means any `agent:<that-persona>` label gets `summary.no_agent` instead of progress.

If a slimmed persona misses a concern it should have caught, see [`docs/persona-regression.md`](docs/persona-regression.md) for the diagnosis and rollback recipe.

### Halt and recovery

Three ways to halt:

- `POST /halt` (or `PUT /control/halt {"halted":true}`) — sticky flag in the coordinator's DB
- Apply the `halt-agents` label to any issue/PR — the work-poller observes it and halts on the next tick (also re-detected on coordinator boot via the GitHub Search API)
- Press `h` in the TUI

A halted coordinator stops dispatching new work. In-flight jobs continue. Halt does NOT auto-clear when the label is removed (the work-poller's `since=` filter could miss the removal). Resume with `POST /resume` or `PUT /control/halt {"halted":false}` or `h` again in the TUI.

When an agent hits an SDK / auth / config error, it transitions to `FAILURE`. This is sticky: the agent rejects all dispatches with 503 until you run `POST /agents/<id>/reset` (which makes the agent reload its SOUL, re-validate env, and re-register).

When a job fails for any reason that isn't operator-fixable (`task_error`, `sdk_failure`, `auth_failure`, `config_failure`), the agent applies the `needs-human` label and posts a comment with the error. That target stays out of routing until a human removes the label.

## Configuration

### GitHub App setup

The system needs ONE GitHub App, installed on the repos you want it to manage. The same App credentials are used by the coordinator and every agent.

Required permissions:
- **Contents**: Read & Write
- **Issues**: Read & Write
- **Pull requests**: Read & Write
- **Metadata**: Read
- (optional) **Members**: Read — for some org-level operations

Subscribe to events: not required (the system polls; it doesn't use webhooks).

After creating, install the App on your sandbox repo. You'll need:
- App ID
- Installation ID (visible in the App's installation URL)
- Private key (download `.pem`)
- A username for git commit attribution (your bot user, or your own)

### Anthropic API key

The agent's `LiveClaudeAdapter` calls the Claude Agent SDK. Set `ANTHROPIC_API_KEY=sk-ant-...` on every agent. If unset, the agent falls back to a stub adapter that produces deterministic mock responses — useful for E2E tests against the routing pipeline without real model calls. Set `CLAUDE_ADAPTER=stub` to force the stub even when a key is present, or `CLAUDE_ADAPTER=live` to require the real SDK.

### Coordinator env

| Variable                       | Default      | Description                                                    |
| ------------------------------ | ------------ | -------------------------------------------------------------- |
| `PORT`                         | `8080`       | HTTP port                                                      |
| `HOST`                         | `0.0.0.0`    | Bind interface                                                 |
| `DATA_DIR`                     | `/data`      | Where SQLite lives (`coordinator.db`)                          |
| `LOG_LEVEL`                    | `info`       | `fatal`/`error`/`warn`/`info`/`debug`/`trace`                  |
| `GITHUB_APP_ID`                | —            | Required unless `DISABLE_GITHUB=true`                          |
| `GITHUB_APP_PRIVATE_KEY`       | —            | PEM body. Literal `\n` sequences are auto-restored to newlines |
| `GITHUB_APP_INSTALLATION_ID`   | —            | Required unless `DISABLE_GITHUB=true`                          |
| `GITHUB_USER`                  | —            | Required unless `DISABLE_GITHUB=true`                          |
| `DEFAULT_POLL_INTERVAL_S`      | `30`         | Default per-repo polling cadence on first discovery            |
| `INSTALLATION_REFRESH_S`       | `300`        | How often to re-list installation repos                        |
| `JOB_COMPLETION_POLL_S`        | `5`          | Job-completion-poller cadence                                  |
| `WORK_POLL_S`                  | `30`         | Work-poller tick rate (floor for per-repo cadence)             |
| `STALE_JOB_TIMEOUT_S`          | `1800`       | Sweep stuck `*-in-progress` labels older than this             |
| `STALE_JOB_SWEEP_S`            | `600`        | Stale-sweeper cadence                                          |
| `FAILED_DISPATCH_RETENTION_DAYS` | `7`        | GC retention for `failed_to_dispatch` rows                     |
| `COMPLETED_JOB_RETENTION_DAYS` | `30`         | GC retention for `complete`/`failed` rows                      |
| `PR_MAX_REVIEW_CYCLES`         | `5`          | Max automated review ↔ address-review iterations per PR. Applies `needs-human` when exceeded. (#70) |
| `DISABLE_GITHUB`               | `false`      | Skip the GitHub client entirely (tests/smoke runs)             |

### Agent env

| Variable                       | Default                 | Description                                              |
| ------------------------------ | ----------------------- | -------------------------------------------------------- |
| `AGENT_PORT` / `PORT`          | `8080`                  | HTTP port                                                |
| `HOST`                         | `0.0.0.0`               | Bind interface                                           |
| `SOUL_PATH`                    | `/etc/agentify/SOUL.md` | Bind-mount your soul here                                |
| `WORKSPACES_DIR`               | `/workspaces`           | Per-repo bare clones + per-job worktrees go here         |
| `LOG_LEVEL`                    | `info`                  |                                                          |
| `COORDINATOR_URL`              | —                       | Required, e.g. `http://coordinator:8080`                 |
| `AGENT_PUBLIC_URL`             | —                       | Required, the URL the coordinator can reach this agent at|
| `REGISTER_RETRY_MS`            | `2000`                  |                                                          |
| `REGISTER_MAX_ATTEMPTS`        | `60`                    |                                                          |
| `HEARTBEAT_INTERVAL_MS`        | `15000`                 |                                                          |
| `COORDINATOR_TIMEOUT_MS`       | `15000`                 |                                                          |
| `JOB_HISTORY_CAPACITY`         | `500`                   | LRU cap on the in-memory `state.jobs` Map                |
| `CLAUDE_MAX_TURNS`             | `500`                   | Fallback turn cap for any method whose per-method var is unset |
| `CLAUDE_MAX_TURNS_PLAN`        | `100`                   | Turn cap for the plan skill                              |
| `CLAUDE_MAX_TURNS_IMPLEMENT`   | `250`                   | Turn cap for the implement skill                         |
| `CLAUDE_MAX_TURNS_REVIEW`      | `60`                    | Turn cap for the review skill                            |
| `CLAUDE_MAX_TURNS_ADDRESS_REVIEW` | `200`               | Turn cap for the address-review skill                    |
| `CLAUDE_MAX_TURNS_MERGE`       | `50`                    | Turn cap for the merge skill                             |
| `CLAUDE_TIMEOUT_MS`            | `900000` (15 min)       | Per-skill wall-clock cap. `0` disables.                  |
| `CLAUDE_COST_LIMIT_USD`        | `5.0`                   | Per-job USD ceiling. `0` disables. Aborts with `task_error` when exceeded. |
| `CLAUDE_ADAPTER`               | `auto`                  | `auto`, `live`, or `stub`                                |
| `ANTHROPIC_API_KEY`            | —                       | Required for the live adapter                            |
| `GITHUB_APP_*` / `GITHUB_USER` | —                       | Same as coordinator. Not needed if `DISABLE_GITHUB=true` |
| `DISABLE_GITHUB`               | `false`                 | Mock all GitHub mutations (logs only)                    |

See [`packages/agent/README.md` — Turn budgets](packages/agent/README.md#turn-budgets) for the per-method defaults, override precedence, and rationale.

## Tuning for token cost

The main levers are turn budgets (#67), a per-job cost ceiling (#68), the PR-review cycle cap (#70), and model selection per method.

### Cost-control knobs

| Knob | Where set | Default | Effect |
| ---- | --------- | ------- | ------ |
| `CLAUDE_MAX_TURNS_PLAN` | agent env | `100` | Max SDK turns for the plan skill |
| `CLAUDE_MAX_TURNS_IMPLEMENT` | agent env | `250` | Max SDK turns for implement |
| `CLAUDE_MAX_TURNS_REVIEW` | agent env | `60` | Max SDK turns for review |
| `CLAUDE_MAX_TURNS_ADDRESS_REVIEW` | agent env | `200` | Max SDK turns for address-review |
| `CLAUDE_MAX_TURNS_MERGE` | agent env | `50` | Max SDK turns for merge |
| `CLAUDE_COST_LIMIT_USD` | agent env | `5.0` | Abort and return `task_error` when cumulative SDK cost exceeds this. `0` disables. |
| `PR_MAX_REVIEW_CYCLES` | coordinator env | `5` | After this many review ↔ address-review cycles on one PR the coordinator applies `needs-human` instead of dispatching another reviewer. |

Turn budgets cap the number of SDK round-trips; the cost ceiling is a dollar backstop for runaway jobs that accumulate expensive model calls before the turn budget fires.

### Model recommendations (`models.*` in SOUL.md)

The built-in souls use this pattern:

```yaml
models:
  plan: claude-opus-4-7          # high-stakes reasoning, file triage, child-issue decomposition
  implement: claude-sonnet-4-6   # balanced cost/capability for most code changes
  review: claude-opus-4-7        # correctness and security review benefits from the best model
  address_review: claude-sonnet-4-6
  merge: claude-haiku-4-5-20251001  # mechanical: check approvals, squash, push
```

Rough cost ratios (input tokens, as of 2026): Opus ~15×, Sonnet ~3×, Haiku ~0.25× relative to each other. For a repo with many small PRs you can move `review` to Sonnet without a noticeable quality drop; move `plan` to Sonnet only for simple repos where issues rarely require deep cross-file reasoning.

### Prompt-cache TTL and low-traffic setups

The Anthropic API caches prompt prefixes for **5 minutes**. Each agent's system prompt (preset + persona body + skill body) is stable across calls for the same method, so back-to-back jobs of the same type on the same agent hit the cache and pay only cache-read rates.

In low-traffic setups where the same agent handles one job every few hours, every job is a cache miss. This does not break anything — it just means you won't see the cache-hit savings that high-traffic deployments enjoy. If cost is a concern at low throughput, prefer Sonnet or Haiku over Opus, and tighten `CLAUDE_MAX_TURNS_*` to realistic ceilings for your workload.

### Session carve-out for `review` and `merge`

`review` and `merge` never resume a prior Claude session and never persist a new one (#69). Each call reads fresh state and makes a point-in-time decision; carrying forward the conversation from a previous PR review wastes cache-read tokens on stale context. If you see no `PUT /sessions` call after a review or merge job, that is expected — it is not a missing-session bug.

`plan`, `implement`, and `address_review` do persist sessions: accumulated context from earlier jobs in the same thread (plan → implement → address_review) improves output quality at the cost of a growing session.

A SOUL.md is bind-mounted into each agent at `/etc/agentify/SOUL.md`. It has YAML frontmatter and a markdown body:

```markdown
---
name: tinkerer            # alphanumeric, dashes, underscores. 1–64 chars
type: tinkerer            # one of the built-ins, or "custom"
version: 0.1.0
git:                      # optional — falls back to persona defaults
  name: The Tinkerer
  email: tinkerer@agentify.local
signature: "🔧 **The Tinkerer** · Implementation Specialist"
models:                   # optional per-method model override
  plan: claude-opus-4-7
  implement: claude-sonnet-4-6
  review: claude-opus-4-7
  address_review: claude-sonnet-4-6
  merge: claude-haiku-4-5-20251001
supported_methods:        # optional — defaults to all 5
  - plan
  - implement
---

# The Tinkerer

You are The Tinkerer — a pragmatic, hands-on engineer who ships small, well-tested
changes quickly. You read carefully before you write, prefer the smallest correct
diff, and never invent abstractions that aren't earned.

## Skill: plan
<!-- Optional override of the bundled plan.md template.
     Empty body = use default. -->

## Skill: implement
You implement against the simplest interpretation of the issue …
```

The persona body is sent as the SDK's `systemPrompt` (appended to the bundled `claude_code` preset). Skill bodies are sent as the user message with `{{signature}}` substituted directly into the template. The four per-job tokens (`{{repo}}`, `{{target_id}}`, `{{agent_name}}`, `{{persona}}`) are not substituted into the body; their values are appended as a trailing **Task vars** block that the model reads at dispatch time. See [docs/skills.md](docs/skills.md) for the full token reference.

You can hot-reload a soul by editing the mounted file and `POST /agents/<id>/reset` (the agent re-parses, re-registers, clears any FAILURE).

## Operating

### TUI

```sh
agentify              # the dashboard
agentify status       # one-shot snapshot
agentify status --json
agentify --help
```

In the dashboard:

| Key       | Action                                            |
| --------- | ------------------------------------------------- |
| `d`       | Dashboard                                         |
| `a`       | Agents                                            |
| `j`       | Jobs                                              |
| `r`       | Repos                                             |
| `l`       | Logs                                              |
| `h`       | Halt / resume (with confirmation)                 |
| `R`       | Reset selected agent (Agents screen)              |
| `1`–`5`   | Set log min level (Logs screen)                   |
| `PgUp/Dn` | Scroll log history                                |
| `g` / `G` | Jump to live tail                                 |
| `q`       | Quit                                              |

CLI flags: `-c <url>` / `--coordinator <url>`, `-p <ms>` / `--poll <ms>`, `--json` (status only).

### HTTP API

**Coordinator** (`http://coordinator:8080`):

| Method | Path                                | Use                                                 |
| ------ | ----------------------------------- | --------------------------------------------------- |
| GET    | `/health`                           | `{ok, service, version, uptime_s}`                  |
| GET    | `/agents`                           | List all registered agents                          |
| POST   | `/agents/register`                  | Called by agents on boot                            |
| GET    | `/agents/:id`                       | Get one agent record                                |
| POST   | `/agents/:id/heartbeat`             | Called by agents every `HEARTBEAT_INTERVAL_MS`      |
| GET    | `/agents/:id/jobs?limit=N`          | Recent jobs for an agent                            |
| DELETE | `/agents/:id`                       | Evict an agent (its active jobs are marked orphaned)|
| POST   | `/agents/:id/reset`                 | Tells the agent to reload SOUL + re-register        |
| GET    | `/sessions/:id/:org/:repo`          | Read a per-repo Claude session id                   |
| PUT    | `/sessions/:id/:org/:repo`          | Persist a session id                                |
| GET    | `/repos`                            | List discovered repos                               |
| PATCH  | `/repos/:owner/:name`               | Tune `active`, `poll_interval_s`                    |
| GET    | `/jobs?status=open\|recent\|all&limit=N` | Job records                                    |
| GET    | `/control/halt`                     | `{halted: bool}`                                    |
| PUT    | `/control/halt`                     | `{halted: bool}` — canonical halt control           |
| POST   | `/halt` / `POST /resume`            | Convenience aliases for the TUI                     |
| GET    | `/logs/stream?live=1`               | SSE stream of structured log events                 |
| GET    | `/metrics`                          | Prometheus text format                              |

**Agent** (`http://<agent>:8080`):

| Method | Path                                | Use                                                 |
| ------ | ----------------------------------- | --------------------------------------------------- |
| GET    | `/health`                           | `{ok, service: "agent:<name>", version, uptime_s}`  |
| GET    | `/status`                           | `{status, agent_id, current_job, last_failure}`     |
| GET    | `/jobs/:id`                         | One job record (history kept up to `JOB_HISTORY_CAPACITY`) |
| POST   | `/plan` / `/implement` / `/review` / `/address-review` / `/merge` | Coordinator dispatches here. 202 on accept, 409 if BUSY, 503 if FAILURE / NOT_REGISTERED / SHUTTING_DOWN, 405 if method not in `supported_methods` |
| POST   | `/reset`                            | Reload SOUL + re-register. 409 if BUSY, 503 on init failure |
| GET    | `/logs/stream?live=1`               | SSE                                                 |
| GET    | `/metrics`                          | Prometheus text format                              |

### Logs and metrics

Both services log structured JSON via pino. The coordinator forwards every agent's `/logs/stream` to its own bus, so `curl -N http://coordinator:8080/logs/stream` is a single tail of the entire fleet.

Prometheus metrics are at `/metrics` on each service:
- Coordinator: `agentify_jobs_total{method,outcome}`, `agentify_dispatched_total{method,kind}`, `agentify_dispatch_latency_ms`, plus `agentify_coordinator_*` defaults.
- Agent: `agentify_jobs_total{method,outcome}`, `agentify_job_duration_ms`, `agentify_claude_tokens_total{kind}`, `agentify_claude_cost_usd_total{method}`, plus `agentify_agent_*` defaults. Default labels carry `persona`.

## Development

```sh
pnpm install
pnpm build              # all packages
pnpm typecheck
pnpm test               # vitest, no live deps
pnpm lint
pnpm format             # prettier --write
```

The vitest config aliases `@agentify/shared` to `packages/shared/src/index.ts`, so tests run against current source without rebuilding `shared` first.

### Layout

```
packages/
  shared/        Zod schemas, log bus, SSE helpers, label & method constants
  coordinator/   Fastify + SQLite + GitHub poller + dispatcher
  agent/         Fastify + Claude Agent SDK + per-job worktree
  tui/           Ink-based dashboard
  e2e/           Doctor + happy-path E2E harness (real GitHub + real model)
```

### E2E

```sh
# Pre-flight check — validates env, coordinator reachability, agent readiness,
# GitHub App auth, repo accessibility.
pnpm e2e:doctor

# Happy-path: opens a sandbox issue, waits for the planner to dispatch and
# complete, asserts child issues exist with `Parent: #N` references.
TEST_REPO=your-org/sandbox \
TEST_PERSONA=orchestrator \
CLEANUP=1 \
  pnpm e2e:run
```

### Adding a new persona

1. Drop a new SOUL.md in `souls/` (e.g. `souls/my-bot.md`). Use `type: custom` and a unique `name`.
2. Add a service block in `docker-compose.yml` mirroring the others, mounting your soul at `/etc/agentify/SOUL.md`.
3. Apply `agent:my-bot:plan` to a sandbox issue.

## Reference

### Job lifecycle

```
   coordinator                          agent
   ───────────                          ─────
   work-poller sees                     IDLE
   `agent:X:plan` on issue 7
              │
              ▼
   pickIdleAgent → mark agent BUSY
   insert jobs row (status=dispatched)
   POST /plan {job_id, repo, id, session_id}
              │ ─────────────────────► state.startJob
              │                        flip to BUSY
              │                        ◄───── 202 {agent_id, status:BUSY}
              │
   updateJobStatus(running)             flip routing label to in-progress
                                        worktreeManager.prepare
                                        Claude SDK runs the skill
                                        on success: remove in-progress + routing label
                                        on failure: comment + needs-human
                                        state.completeJob → IDLE
                                        coordinator.putSession(session_id)*
              │
              ▼
   job-poller's /status sees IDLE
   /jobs/:id returns terminal record
   updateJobStatus(complete|failed)
   recordHeartbeat(IDLE)
```

`*` skipped for `review` / `merge`; see [SPEC §9](SPEC.md#9-session-management).

### Outcomes

| Outcome           | Meaning                                                  | Recovery                                |
| ----------------- | -------------------------------------------------------- | --------------------------------------- |
| `success`         | Skill completed                                          | —                                       |
| `task_error`      | Skill ran but returned an error result (or hit timeout)  | `needs-human` applied; agent stays IDLE |
| `orphaned`        | Job was dispatched but the agent has no record           | `needs-human` not applied (already gone)|
| `sdk_failure`     | Claude SDK threw                                         | Agent → FAILURE; `POST /reset` to clear |
| `auth_failure`    | 401/403 from Anthropic or GitHub                         | Agent → FAILURE; verify creds; `/reset` |
| `config_failure`  | Worktree prep failed, env missing, etc.                  | Agent → FAILURE; fix; `/reset`          |

### Storage

Coordinator state is in `${DATA_DIR}/coordinator.db` (SQLite, WAL mode). Migrations run at boot; the full schema is documented in SPEC.md §11.1. Sessions cascade-delete with their agent. Jobs do not — but `DELETE /agents/:id` orphan-marks active jobs in the same transaction so they don't block re-dispatch of their targets.

Agents are stateless across restarts. The in-memory job history is bounded (`JOB_HISTORY_CAPACITY`, default 500). Per-repo bare clones live under `WORKSPACES_DIR` and persist across runs; per-job worktrees are created and removed per skill invocation.

### Limits

- One job per agent at a time. The dispatcher reserves the agent BUSY before the HTTP roundtrip to prevent parallel cross-repo branches from double-picking.
- Coordinator runs on a single SQLite database, so write throughput is capped at SQLite's WAL write rate (thousands of writes per second — not the bottleneck for this workload).
- The system has no auth/authz on its own surface. Run on a private network.
