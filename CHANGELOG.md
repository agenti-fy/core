# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
- **Combined-label routing** — work dispatched purely by `agent:<persona>` + `task:<method>` GitHub labels; no webhooks required.
- **SOUL.md format** — YAML frontmatter + Markdown body for persona identity, per-method model overrides, and skill-prompt overrides.
- **Halt/resume** — via label (`halt-agents`), HTTP (`POST /halt`, `POST /resume`), or TUI keypress.
- **Prometheus metrics** on both coordinator and agent (`/metrics`).
- **SSE log streaming** — coordinator fans out all agent streams to a single endpoint.
- **Stub Claude adapter** for integration testing without real model calls.
- **Docker Compose** setup running one container per built-in persona.
