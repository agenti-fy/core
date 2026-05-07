# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Knowledge base** — per-repo, wiki-backed durable memory available to every persona on every skill run; pages are read at job start and optionally appended to at end via the bundled `agentify-kb` CLI. See `docs/knowledge-base.md` and SPEC.md §23. (#226)
- `KB_ENABLED` (default `true`), `KB_GLOBAL_PAGE` (default `KB-Global`), `KB_PAGE_PREFIX` (default `KB-`), `KB_WRITE_RETRY_MAX` (default `3`), `KB_ENTRY_MAX_BYTES` (default `1024`): five KB config vars first landed in #254 (parent plan #226) are now surfaced in the operator-facing docs. The bool uses `${KB_ENABLED:-true}` (colon-dash) in compose so an unset env resolves to `true`, not empty-string `false`. Documented in `.env.example`, `README.md`, `docker-compose.yml`, and `CHANGELOG.md`. Closes #327.
- `MAX_RESULT_JSON_BYTES` (default `262144`, 256 KiB): hard cap on the serialized job result persisted to `jobs.result_json` (#288). Jobs whose result exceeds the cap are recorded as `task_error` with `artifacts: {}` to keep the row valid JSON for downstream consumers. Documented in `.env.example`, `README.md`, `docker-compose.yml`, `docs/operations.md`, and `packages/coordinator/README.md`.
- `CLAUDE_COST_LIMIT_USD` (default `5.0` USD, `0` disables): per-job cost ceiling in the live adapter (#98). When the cumulative cost reported by the SDK crosses the ceiling the job is aborted with `task_error`. Documented in `.env.example`, `README.md`, `docker-compose.yml`, `docs/operations.md`, and `packages/agent/README.md`.
- **TUI per-job tokens and cost**: the recent-jobs table now includes a `$cost` column, and selecting a job shows a token/cost breakdown panel with input, output, cache-read, and cache-write token counts (thousands-separated) and cost to 4 decimal places. Jobs predating the `usage` fields in `JobResult` render `—` in the column and show no detail panel (#147).
- **KB Prometheus counters** (Phase 1 of #226): `agentify_kb_reads_total` (by `scope`), `agentify_kb_writes_total` (by `scope` and `outcome`), and `agentify_kb_write_conflicts_total` are now registered on agent startup; operators will see zero-valued series from the first deploy, enabling alerting before any KB traffic. Closes #249.
- Hardened `KB_GLOBAL_PAGE` validator: now restricted to `[A-Za-z0-9 _-]+`, rejecting shell metacharacters, path separators, and leading dots before Phase 2 wires the value into git argv and file paths (#264).
- `KB_ENTRY_MAX_BYTES` upper-bound ceiling: values above 10 MiB (10 485 760 bytes) are now rejected at startup by the zod schema to prevent operator typos from committing gigantic blobs to the wiki git tree (#282). To raise the ceiling legitimately, increase `KB_ENTRY_MAX_BYTES_CEILING` in `packages/agent/src/config.ts` and document the new value in `docs/operations.md`.

### Changed

- Dispatch order: within each repo bucket, `dispatchBatch` now sorts items by `(method-priority DESC, target_id ASC, persona_name ASC)` — `merge > address_review > review > implement > plan` drains lifecycle-late in-flight work before starting lifecycle-early work, so merge-ready changes land sooner and sibling PRs accumulate less rebase debt against `main`; within a method, older issues/PRs (lower IDs) win the available agent first. Closes #403, #410 (refs #402, #408).
- Document priority-first dispatch ordering in `SPEC.md §8.3` and `packages/coordinator/README.md`: updated bullet (item 2) describes the `(method-priority DESC, target_id ASC, persona_name ASC)` tuple, the lifecycle-drain rationale, the deterministic tie-breaker keys, and the no-global-ordering note across repos. Closes #404 (refs #402, #408, #410).
- Align `SPEC.md §23.5 step 5` to reference `KB_WRITE_RETRY_MAX` (default 3) instead of the hardcoded literal "3", adding "exponential backoff" phrasing to match `docs/knowledge-base.md`. Closes the drift flagged by #361; traces back to the env var shipped in #354 and the plan in #371.
- Align `KB_WRITES_MAX_MSG` wording from "per job" to "per slot" in `packages/shared/src/rpc.ts`, matching the updated `SPEC.md §6.4` wording introduced in PR #348 (parent issue #357).
- Lift the `kb_writes` cap (64) and its error message into the exported `KB_WRITES_MAX` / `KB_WRITES_MAX_MSG` constants in `packages/shared/src/rpc.ts`. Removes 5× duplication of the literal flagged in PR #291. Closes #336.
- Drop the now-unreachable `.endsWith('.md')` refine on `KB_GLOBAL_PAGE` (#330). The strict allowlist regex landed in #328 already excludes `.`; invalid inputs still throw, just with the regex error message rather than the suffix-refine one.
- **Tool scoping**: deny `Task`, `WebFetch`, `WebSearch` for all five methods; restrict `plan` and `review` to a `Bash` allowlist (`gh *`, `git log/show/diff/rev-parse`, `ls`, `cat`, `agentify-kb*`, `/usr/local/bin/agentify-kb*`). Closes #65.
- Extend the `plan`/`review` Bash allowlist with `Bash(agentify-kb*)` and `Bash(/usr/local/bin/agentify-kb*)` so those methods can write KB entries via the controlled CLI helper; the absolute-path variant guards against `$PATH` resolution quirks in the SDK subprocess. Phase 3 of #226. Closes #262.
- `POST /reset` now hot-reloads `CLAUDE_MAX_TURNS_*` per-method turn caps (#93) and `CLAUDE_TIMEOUT_MS` (#103) without a process restart; static-at-boot settings (host, port, coordinator URL, agent public URL, heartbeat interval, credentials) still require a restart.
- Skill-body template tokens `{{repo}}`, `{{target_id}}`, `{{agent_name}}`, and `{{persona}}` are no longer interpolated into the skill template. Their values now appear in a trailing **Task vars** block appended to `skillPrompt`; only `{{signature}}` is still substituted directly into the template. This makes the stable prefix byte-identical across jobs, enabling prompt-cache hits.
- **Prompt caching**: `systemPrompt` is now sent as a `string[]` with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` separating the cacheable stable prefix (persona body + skill template) from the volatile task-vars trailer. Replaces the prior `{ type: 'preset', preset: 'claude_code', append: personaBody }` form; `cache_read` tokens become non-zero on warm runs. Closes #64.
- **setup**: removed unused `ownerType` and `orgLogin` fields from the `BuildManifestArgs` interface in `packages/setup/src/manifest.ts` (and the matching `ownerType: 'user'` placeholders from `manifest.test.ts` call sites). The fields had no effect on `buildManifest` output and no external caller passed them; `ManifestStartUrlArgs` is unchanged because its `ownerType`/`orgLogin` actively drive the manifest start URL. (#461, closes #452.)

### Fixed

- setup: `APP_PERMISSIONS` now includes `wiki: write` so wizard-created Apps can push KB pages out of the box (#437).
- `pnpm typecheck` succeeds on a clean checkout without a prior `pnpm build` (#192): switched from `tsc -p tsconfig.json --noEmit` (per-package) / `pnpm -r typecheck` (root) to `tsc -b` (project-references build mode), which resolves the reference graph in dependency order. `--noEmit` was dropped because TypeScript propagates it to referenced `composite` projects, triggering TS6310.
- **TUI**: jobs cursor `›` indicator no longer disappears when `recentJobs` shrinks under the cursor (#160).
- **TUI**: agents cursor `›` indicator no longer disappears when the agents list shrinks under the cursor between polls; `R` reset now targets the visually highlighted row rather than silently no-op'ing on a stale index (#174, closes #173).
- CHANGELOG: align v0.1.0 "Combined-label routing" entry with the `agent:<persona>:<method>` format that actually shipped (was previously described as the older `agent:<persona>` + `task:<method>` split — follow-up to #76, surfaced by #80).
- Treat empty-string `CLAUDE_TIMEOUT_MS` as unset rather than coercing to `0` (which previously silently disabled wall-clock timeouts). Affects compose `${VAR-}` expansions where the variable is not set in the environment. (#129, closes #127.)
- Treat empty-string env vars for all numeric fields in coordinator config (`packages/coordinator/src/config.ts`) as unset rather than coercing to `0` (which previously crashed the coordinator at startup on `.positive()` schema constraints). Affects compose `${VAR-}` expansions where the variable is not set in the environment. Adds `packages/coordinator/src/config.test.ts` with regression coverage. (#283, closes #281.)
- Treat empty-string env vars for the remaining numeric fields in agent config (`packages/agent/src/config.ts`) — `AGENT_PORT`/`PORT`, `REGISTER_RETRY_MS`, `REGISTER_MAX_ATTEMPTS`, `HEARTBEAT_INTERVAL_MS`, `COORDINATOR_TIMEOUT_MS`, `JOB_HISTORY_CAPACITY`, `CLAUDE_MAX_TURNS`, `CLAUDE_MAX_TURNS_{PLAN,IMPLEMENT,REVIEW,ADDRESS_REVIEW,MERGE}`, `CLAUDE_COST_LIMIT_USD` — as unset rather than coercing to `0` (which previously crashed the agent at startup on `.positive()`/`.min(1)` schema constraints). Affects compose `${VAR-}` expansions where the variable is not set. Adds regression coverage in `packages/agent/src/config.test.ts`. (#313, closes #280.)
- Sync SPEC.md §6.4 `JobResult` type with `JobResultSchema` in `packages/shared/src/rpc.ts`: add `final_text?`, `usage_input?`, `usage_output?`, `usage_cache_read?`, `usage_cache_write?`, `cost_usd?`; add `'orphaned'` to the `outcome` union; change `session_id` to `string | null`. Closes #144 (refs #142, #66).

### Security

- Hardened `parseRepo` with a charset allowlist (`^[A-Za-z0-9_.-]+$` per segment), closing a shell-quoting break in `credentialHelperCommand` and every other call-site that interpolates owner/repo into shell strings (#342). Inputs containing shell metacharacters, spaces, or other disallowed bytes now throw `invalid repo "…" — contains disallowed characters` so operators can grep the error suffix in logs.

## [0.1.0] - 2026-05-05

Initial release of the agenti-fy multi-agent development system.

### Added

- **Coordinator service** — polls GitHub every `WORK_POLL_S` seconds, routes work to idle agents via HTTP, owns SQLite state (agents, sessions, jobs, repos, control).
- **Agent service** — Fastify HTTP service wrapping the Claude Agent SDK; runs per-job git worktrees; registers and heartbeats with the coordinator.
- **TUI** (`@agentify/tui`) — Ink-based terminal dashboard with live log streaming, agent/job/repo views, and keyboard halt/resume.
- **E2E harness** (`@agentify/e2e`) — pre-flight doctor and happy-path scenario against a real GitHub repo and live model.
- **Shared library** (`@agentify/shared`) — Zod schemas, log bus, SSE helpers, label and method constants.
- **Five built-in skills**: `plan`, `implement`, `review`, `address-review`, `merge`.
- **Nine built-in personas**: `orchestrator`, `conductor`, `theorist`, `tinkerer`, `optimizer`, `glue`, `skeptic`, `crafter`, `scribe`.
- **Combined-label routing** — work dispatched purely by `agent:<persona>:<method>` GitHub labels; no webhooks required.
- **SOUL.md format** — YAML frontmatter + Markdown body for persona identity, per-method model overrides, and skill-prompt overrides.
- **Halt/resume** — via label (`halt-agents`), HTTP (`POST /halt`, `POST /resume`), or TUI keypress.
- **Prometheus metrics** on both coordinator and agent (`/metrics`).
- **SSE log streaming** — coordinator fans out all agent streams to a single endpoint.
- **Stub Claude adapter** for integration testing without real model calls.
- **Docker Compose** setup running one container per built-in persona.
