# @agentify/agent

The per-persona HTTP service that accepts dispatch requests from the coordinator, runs skills via the Claude Agent SDK, and reports results back through GitHub labels and comments.

## Purpose

Each agent process owns one persona (defined by its `SOUL.md`). The coordinator dispatches a job by `POST`ing to a method route; the agent runs the skill inside an isolated git worktree and then flips the target issue's GitHub labels to reflect the outcome. Agents are stateless between jobs except for the in-memory job history ring and the per-repo bare-clone cache on disk.

## Boot sequence

Source: `src/index.ts`

1. `loadConfig()` — parse and validate env vars via Zod (`src/config.ts`).
2. `loadSoulFromFile(config.soulPath)` — parse `SOUL.md` YAML frontmatter + body.
3. `createLogger()` — structured pino logger with soul name/type in base fields.
4. Construct subsystems: `AgentState`, `CoordinatorClient`, `SoulRef`, `ClaudeAdapter` (see adapter selection below), `GitHubAdapter`, `WorktreeManager`, `AgentMetrics`, `SkillRunner`.
5. `buildAgentServer(deps)` — register all Fastify routes.
6. `app.listen()` — bind port **before** registering with the coordinator, so the endpoint is reachable the moment the coordinator has the URL.
7. `registerWithRetry()` — `POST /agents` on the coordinator, retrying up to `REGISTER_MAX_ATTEMPTS` (default 60) with `REGISTER_RETRY_MS` (default 2 s) back-off.
8. Start heartbeat `setInterval` (default 15 s). On 404 the agent automatically re-registers.
9. Listen for `SIGINT`/`SIGTERM`: drain any in-flight skill run, close SSE streams, close Fastify, exit 0.

## Subsystems

### `claude/`

| File | Role |
|---|---|
| `adapter.ts` | `ClaudeAdapter` interface — `run(opts): Promise<SkillRunOutput>` |
| `live.ts` | `LiveClaudeAdapter` — wraps `@anthropic-ai/claude-agent-sdk` |
| `stub.ts` | `StubClaudeAdapter` — returns a canned success response; no API calls |

### `soul/`

- `parser.ts` — `parseSoul(text)` / `loadSoulFromFile(path)`: split YAML frontmatter from body, extract `## Skill: <method>` override sections.
- `ref.ts` — `SoulRef`: mutable holder so `POST /reset` can hot-swap the active soul without restarting the process.

### `skills/`

- `resolver.ts` — `resolveSkill(opts)`: assembles the final `personaBody`, `skillPrompt`, and `systemPrompt` for one SDK call. Skill body comes from the SOUL override (`## Skill: <method>`) when present; otherwise falls back to the bundled default.
- `defaults/` — one `.md` per method (`plan.md`, `implement.md`, `review.md`, `address-review.md`, `merge.md`). Bundled into `dist/` at build time.

### `runner/`

- `skill-runner.ts` — `SkillRunner`: orchestrates a single job end-to-end. `enqueue(req)` fires a `setImmediate`-deferred `run()` and exposes `inFlight()` for graceful shutdown drain. See [State machine](#state-machine) and [Worktree lifecycle](#worktree-lifecycle) below.

### `git/worktree.ts`

`WorktreeManager` — maintains a persistent bare clone per repo and creates/removes an ephemeral linked worktree per job. See [Worktree lifecycle](#worktree-lifecycle).

### `github/client.ts`

`GitHubAdapter` (Octokit wrapper). Methods used by the runner: `listLabels`, `replaceLabels`, `removeLabels`, `postIssueComment`, `appendToIssueBody`, `getPullRequest`. When `DISABLE_GITHUB=true` the adapter is a no-op stub so jobs can run locally without real GitHub side-effects.

### `routes/`

| Route | File | Notes |
|---|---|---|
| `GET /health` | `health.ts` | Liveness probe; returns service name + uptime |
| `GET /status` | `status.ts` | Current state, active job, last failure |
| `POST /<method>` | `methods.ts` | Dispatch — one route per method (`plan`, `implement`, `review`, `address-review`, `merge`) |
| `POST /reset` | `reset.ts` | Hot-reload tunable config (turn budgets, timeout) from env, re-parse SOUL, re-register with coordinator, clear FAILURE |
| `GET /jobs/:id` | `jobs.ts` | Single job record from in-memory history |
| `GET /logs/stream` | `logs.ts` | SSE stream of structured log lines |
| `GET /metrics` | `metrics.ts` | Prometheus exposition |

### `personas/`

Bundled default persona body templates (one `.md` per built-in type: `orchestrator`, `conductor`, `theorist`, `tinkerer`, `optimizer`, `glue`, `skeptic`, `crafter`, `scribe`). These are distinct from the user-provided `SOUL.md` — the resolver uses them only when the SOUL body is empty and the persona type is built-in.

## State machine

Source: `src/state.ts`

```
IDLE ──(startJob)──► BUSY ──(completeJob: success/task_error)──► IDLE
                          └──(completeJob: sdk_failure/auth_failure/config_failure)──► FAILURE
FAILURE ──(POST /reset)──► IDLE
```

- `IDLE` — ready to accept the next dispatch.
- `BUSY` — a skill run is in progress; new dispatches get `409`.
- `FAILURE` — a hard error stopped the runner (SDK crash, bad credentials, config problem). Dispatches get `503`. The operator must fix the root cause and then call `POST /reset`.

## Worktree lifecycle

Source: `src/git/worktree.ts`

```
prepare(repo, job_id)
  mkdir $WORKSPACES_DIR/<org>/<repo>/
  if bare clone missing → git clone --bare <repo> .bare/
  else → git fetch --prune origin  (skipped if fetched within 60 s)
  write/refresh .token (mode 0600, atomic tmp+rename)
  git worktree add -B agentify/job/<job_id> <job_id>/ <default_branch>
  git config user.name/email  ← from SOUL git identity or persona defaults

cleanup(repo, job_id)
  git worktree remove --force <job_id>/
  fallback: rm -rf + git worktree prune
```

Directory layout under `WORKSPACES_DIR` (default `/workspaces`):

```
<org>/<repo>/
  .bare/       ← persistent bare clone; shared across all jobs for that repo
  .token       ← GitHub App installation token, refreshed before each job
  <job_id>/    ← ephemeral linked worktree, removed after the job
```

The credential helper is configured on the bare clone so `git push/fetch/pull` in the worktree authenticate via the token file without the token ever appearing in a URL or subprocess env.

## Adapter selection

Controlled by `CLAUDE_ADAPTER` (default `auto`):

| Value | Behaviour |
|---|---|
| `auto` | Uses `LiveClaudeAdapter` when `ANTHROPIC_API_KEY` is set; `StubClaudeAdapter` otherwise |
| `live` | Always uses `LiveClaudeAdapter` (warns and likely 401s if no API key) |
| `stub` | Always uses `StubClaudeAdapter`; no Claude API calls made |

Source: `src/index.ts` `pickClaudeAdapter()`.

## Budget limits

`LiveClaudeAdapter` enforces per-method turn caps and two shared limits.

### Turn budgets

Each method has its own env var and default:

| Env var | Default | Rationale |
|---|---|---|
| `CLAUDE_MAX_TURNS_PLAN` | 100 | Plan reads many files; needs headroom but rarely loops |
| `CLAUDE_MAX_TURNS_IMPLEMENT` | 250 | Walking a repo + editing + tests can run 50–150 turns |
| `CLAUDE_MAX_TURNS_REVIEW` | 60 | Review reads the diff and posts a comment; rarely deep |
| `CLAUDE_MAX_TURNS_ADDRESS_REVIEW` | 200 | May need to apply many comments across files |
| `CLAUDE_MAX_TURNS_MERGE` | 50 | Merge is narrow: rebase, push, merge; 50 is generous |

`CLAUDE_MAX_TURNS` (legacy) overrides all per-method defaults when set; per-method vars take precedence over it. Budget exhaustion produces a `task_error` outcome.

### Cost ceiling

`CLAUDE_COST_LIMIT_USD` (default `5.0`, `0` disables) sets a per-job USD ceiling. The live adapter reads the cumulative `total_cost_usd` reported on each result message and raises `task_error` the moment the ceiling is crossed. `$5` leaves headroom for a full Opus plan path while catching runaway loops before they become expensive.

Cost tracking is best-effort: older SDK versions may not report per-turn cost data. When a job completes without any cost data the adapter logs a one-time warning but does not abort.

**Hot-reload**: changing `CLAUDE_MAX_TURNS_*`, `CLAUDE_TIMEOUT_MS`, or `CLAUDE_COST_LIMIT_USD` and calling `POST /reset` applies the new value on the next skill run without a process restart. Static-at-boot settings (`HOST`, `PORT`, `COORDINATOR_URL`, `AGENT_PUBLIC_URL`, `HEARTBEAT_INTERVAL_MS`, credentials) require a restart to take effect.

## Knowledge base

Each managed repo accumulates a durable, append-only knowledge base stored as Markdown pages in the repo's GitHub Wiki. At the start of a skill run the agent reads the shared global page (`KB-Global.md`) and the persona-specific page (e.g. `KB-skeptic.md`); at the end of a run the agent may append new observations. The KB lets insights and pitfalls accumulate across successive jobs without inflating Claude's in-context token budget by default. For the full architecture see [SPEC.md §23](../../SPEC.md) and the operator runbook at [docs/knowledge-base.md](../../docs/knowledge-base.md).

### Configuration env vars

These five vars are **boot-only** (not hot-reloadable); a process restart is required to change them.

| Env var | Default | Rationale |
|---|---|---|
| `KB_ENABLED` | `true` | Master toggle — set to `false` to disable all KB reads and writes without touching other config |
| `KB_GLOBAL_PAGE` | `KB-Global` | Name of the shared wiki page visible to every persona; must match `[A-Za-z0-9 _-]+` (WikiManager appends `.md`) |
| `KB_PAGE_PREFIX` | `KB-` | Prefix for persona-specific wiki pages (e.g. `KB-glue`); must match `[A-Za-z0-9-]+` |
| `KB_WRITE_RETRY_MAX` | `3` | Maximum push retries on non-fast-forward conflicts during `agentify-kb append`; integer ≥ 1 |
| `KB_ENTRY_MAX_BYTES` | `1024` | Hard byte cap per appended entry; ceiling `10485760` (10 MiB) — prevents operator typos from ballooning wiki history |

Canonical schema and constraints: `packages/agent/src/config.ts` (`kbEnabled` … `kbEntryMaxBytes` region).

### Runtime env vars (per-job)

`SkillRunner` sets the following env vars for the duration of each skill run and restores the previous values (or unsets them) after the run completes. The `agentify-kb` CLI reads them automatically — no explicit flags required.

| Env var | Set to | Notes |
|---|---|---|
| `KB_CLONE_DIR` | Absolute path to the per-job wiki worktree (e.g. `/workspaces/org/repo/.kb/<job_id>`) | **Unset** (not empty-string) when the wiki is unavailable for this run (wiki not initialised, `KB_ENABLED=false`, or `WikiManager.prepare()` failed). Skills guard KB calls with `if [ -n "$KB_CLONE_DIR" ]`. |
| `AGENTIFY_PERSONA` | Persona name (e.g. `tinkerer`) | Used by `agentify-kb` to derive the persona-scoped page name (e.g. `KB-Tinkerer`). |
| `AGENTIFY_JOB_ID` | Job identifier (e.g. `j_01HXY...`) | Embedded in the commit message and entry source link by `agentify-kb append`. |
| `AGENTIFY_TARGET_ID` | Target issue or PR number as a string | Embedded in the entry source link by `agentify-kb append`. |

Source: `src/runner/skill-runner.ts`.

### The `agentify-kb` CLI

`agentify-kb` is the **only supported write path** for KB pages. Direct `git commit` to a KB page is allowed but discouraged — the helper enforces the append-only page format (date stamp, source link, signature footer, leading horizontal rule) and handles concurrent-push conflicts automatically.

```
agentify-kb append <persona|global>   # read entry from stdin; stamp + push
agentify-kb read   <persona|global>   # cat the page to stdout
agentify-kb list                      # list all pages in KB_CLONE_DIR
```

**KB writes are best-effort.** A push failure (e.g. conflict-retry limit reached) does **not** fail the job — the skill run continues and the job outcome is unaffected. The failure is logged at `warn` level and increments `agentify_kb_writes_total{outcome="conflict_retry_exhausted"}`. See [SPEC.md §23](../../SPEC.md) §23 Risks §3 and [docs/knowledge-base.md](../../docs/knowledge-base.md) for troubleshooting.

## Local dev

Run without GitHub or a real API key:

```bash
DISABLE_GITHUB=true \
CLAUDE_ADAPTER=stub \
COORDINATOR_URL=http://localhost:3000 \
AGENT_PUBLIC_URL=http://localhost:8080 \
SOUL_PATH=../../souls/tinkerer.md \
pnpm --filter @agentify/agent dev
```

`DISABLE_GITHUB=true` skips label flips, comments, and the bare-clone credential setup. `CLAUDE_ADAPTER=stub` returns a canned success response instead of calling the Anthropic API. The coordinator must still be reachable for registration and heartbeats; set `DISABLE_GITHUB=true` on the coordinator too if running end-to-end offline.
