# @agentify/tui

Ink/React terminal dashboard for the agentify coordinator. Renders a live multi-screen UI and also supports one-shot status snapshots.

## Purpose

Connects to a running coordinator over HTTP and SSE, displaying agent health, job queues, managed repos, and a real-time log tail. The `agentify` binary is the primary operator interface for live monitoring and for issuing halt/resume commands.

## Run

Start the interactive dashboard:

```sh
pnpm --filter @agentify/tui start
# or after building:
node packages/tui/dist/index.js
```

One-shot status snapshot (prints and exits):

```sh
agentify status          # human-readable
agentify status --json   # JSON output
```

**CLI flags** (verify in `src/index.ts`):

| Flag | Alias | Default | Description |
| ---- | ----- | ------- | ----------- |
| `--coordinator` | `-c` | `$COORDINATOR_URL` or `http://localhost:8080` | Coordinator base URL |
| `--poll` | `-p` | `1000` | TUI poll interval (ms) |
| `--json` | — | — | Emit JSON in `status` mode |

## Screens

All screens live under `src/screens/`.

| Key | Screen | File | Shows |
| --- | ------ | ---- | ----- |
| `d` | Dashboard | `src/screens/Dashboard.tsx` | All agents with current status and top 10 open jobs |
| `a` | Agents | `src/screens/Agents.tsx` | Full agent list with cursor selection and detail panel |
| `j` | Jobs | `src/screens/Jobs.tsx` | Open jobs and up to 25 recent jobs with status/method |
| `r` | Repos | `src/screens/Repos.tsx` | Managed repos with active/paused state and poll interval |
| `l` | Logs | `src/screens/Logs.tsx` | Real-time SSE log tail with level filtering and scrollback |

## Keybindings

The root [`README.md`](../../README.md#tui) is the canonical keybinding reference. Quick summary (verified against `src/App.tsx`):

| Key | Action |
| --- | ------ |
| `d` / `a` / `j` / `r` / `l` | Switch screen |
| `h` | Halt / resume (modal confirmation) |
| `↑↓` | Move cursor (Agents/Jobs screens) |
| `R` | Reset selected agent (Agents screen) |
| `1`–`5` | Set log min level (Logs screen) |
| `PgUp` / `PgDn` | Scroll log history |
| `g` / `G` | Jump to live tail |
| `q` | Quit |

## Components

Reusable primitives live under `src/components/`.

| Component | File | Role |
| --------- | ---- | ---- |
| `Header` | `src/components/Header.tsx` | Top bar: coordinator URL, agent counts, halt indicator |
| `HaltModal` | `src/components/HaltModal.tsx` | y/n confirmation modal for halt/resume |
| `KeybindBar` | `src/components/KeybindBar.tsx` | Bottom bar showing context-sensitive key hints |
| `Toasts` | `src/components/Toasts.tsx` | Ephemeral error/info notifications |

## Data flow

| Module | File | Role |
| ------ | ---- | ---- |
| HTTP client | `src/api.ts` | Typed wrappers around coordinator REST endpoints (Undici + Zod) |
| Status snapshot | `src/status.ts` | One-shot fetch of agents/jobs/repos for `agentify status` |
| SSE consumer | `src/logs.ts` | Streams `/logs/stream`, reconnects with exponential backoff, replays buffer on first connect only |
| UI state | `src/store.ts` | `useReducer`-based store; `LogRing` (circular buffer, capacity 500) decoupled from React state for performance |

The polling loop in `src/App.tsx` fetches agents, jobs, repos, and halt status every `--poll` ms. Log entries arrive out-of-band via the SSE connection and are written into `LogRing`; a `log_tick` action snapshots the ring into React state each render cycle.

## Local dev

Point `-c` at a locally running coordinator:

```sh
# With a real GitHub App configured
agentify -c http://localhost:8080

# Offline / no GitHub credentials — start coordinator with DISABLE_GITHUB=true
DISABLE_GITHUB=true node packages/coordinator/dist/index.js
agentify -c http://localhost:8080
```

`DISABLE_GITHUB=true` skips GitHub client initialisation in the coordinator, letting the TUI connect and browse agents, jobs, and logs without valid App credentials.
