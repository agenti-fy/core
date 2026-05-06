# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **Tool scoping**: deny `Task`, `WebFetch`, `WebSearch` for all five methods; restrict `plan` and `review` to a read-only `Bash` allowlist (`gh *`, `git log/show/diff/rev-parse`, `ls`, `cat`). Closes #65.
- `POST /reset` now hot-reloads `CLAUDE_MAX_TURNS_*` per-method turn caps (#93) and `CLAUDE_TIMEOUT_MS` (#103) without a process restart; static-at-boot settings (host, port, coordinator URL, agent public URL, heartbeat interval, credentials) still require a restart.
- Skill-body template tokens `{{repo}}`, `{{target_id}}`, `{{agent_name}}`, and `{{persona}}` are no longer interpolated into the skill template. Their values now appear in a trailing **Task vars** block appended to `skillPrompt`; only `{{signature}}` is still substituted directly into the template. This makes the stable prefix byte-identical across jobs, enabling prompt-cache hits.

### Fixed

- CHANGELOG: align v0.1.0 "Combined-label routing" entry with the `agent:<persona>:<method>` format that actually shipped (was previously described as the older `agent:<persona>` + `task:<method>` split — follow-up to #76, surfaced by #80).
- Treat empty-string `CLAUDE_TIMEOUT_MS` as unset rather than coercing to `0` (which previously silently disabled wall-clock timeouts). Affects compose `${VAR-}` expansions where the variable is not set in the environment. (#129, closes #127.)

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
