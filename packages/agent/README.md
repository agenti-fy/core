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
