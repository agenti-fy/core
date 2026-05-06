# @agentify/shared

Types, schemas, constants, and runtime utilities shared across `coordinator`, `agent`, `tui`, and `e2e`.

## Purpose

This package is the single source of truth for cross-cutting contracts:

- Zod schemas validated at every service boundary (RPC, agent registration, job dispatch).
- Label and method constants the coordinator's poller and the agent's runner both agree on.
- Log bus and SSE streaming wired identically in both services.

Nothing here makes network calls or starts processes. Every export is a pure value, a Zod schema, or a stateless helper.

## Exports overview

### Routing / labels (`labels.ts`)

| Export | Description |
|--------|-------------|
| `routingLabel(persona, method)` | Builds `agent:<persona>:<method>` — the dispatchable label form |
| `inProgressLabel(persona, method)` | Builds `agent:<persona>:<method>-in-progress` — the accepted form |
| `parseRoutingLabel(label)` | Parses a label string; returns `ParsedRoutingLabel` or `null` |
| `normalizeIssueLabels(raw)` | Normalizes Octokit's mixed label array to `string[]` |
| `HALT_LABEL` | `"halt-agents"` — coordinator skips all dispatch when present |
| `NEEDS_HUMAN_LABEL` | `"needs-human"` — signals operator attention required |

### Methods (`methods.ts`)

| Export | Description |
|--------|-------------|
| `Method` | Union type: `"plan" \| "implement" \| "review" \| "address_review" \| "merge"` |
| `MethodSchema` | Zod enum for `Method` |
| `METHOD_PATHS` | Map from `Method` → URL path segment (snake_case → kebab-case for `address_review`) |
| `pathToMethod(path)` | Reverse lookup: URL path segment → `Method \| undefined` |

### Personas (`personas.ts`)

| Export | Description |
|--------|-------------|
| `BUILTIN_PERSONAS` | Tuple of the 9 built-in persona names (`orchestrator` … `scribe`) |
| `PersonaType` | `BuiltinPersona \| "custom"` |
| `PERSONA_DEFAULTS` | Per-persona emoji, title, signature, and git identity defaults |
| `isBuiltinPersona(value)` | Type guard: narrows `string` to `BuiltinPersona` |

### Status enums (`status.ts`)

| Export | Description |
|--------|-------------|
| `Status` | `"IDLE" \| "BUSY" \| "FAILURE"` |
| `FailureCode` | `"sdk_failure" \| "auth_failure" \| "config_failure"` |
| `FailureInfo` | `{ code, message, ts }` — carried in agent status responses |

### SOUL schema (`soul.ts`)

| Export | Description |
|--------|-------------|
| `SoulFrontmatterSchema` | Zod schema for SOUL.md YAML frontmatter (`name`, `type`, `version`, `git`, `models`, `supported_methods`) |
| `ParsedSoul` | Parsed SOUL.md: `frontmatter` + `personaBody` + `skillOverrides` |

### DB record schemas (`records.ts`)

These mirror the coordinator's SQLite tables. The Zod schemas are the source of truth; the tables are generated from them.

| Export | Description |
|--------|-------------|
| `AgentRecord` / `AgentRecordSchema` | Registered agent row |
| `JobRecord` / `JobRecordSchema` | Dispatched job row; `status` follows `JobRecordStatus` |
| `RepoRecord` / `RepoRecordSchema` | Watched repo row |

### RPC schemas (`rpc.ts`)

The coordinator–agent HTTP contract. Request and response bodies are validated through these schemas at both ends.

| Export | Description |
|--------|-------------|
| `RepoSchema` / `Repo` | `"<owner>/<repo>"` string with format validation |
| `RegisterRequest` / `RegisterResponse` | Agent self-registration |
| `DispatchRequest` / `DispatchAccepted` | Coordinator dispatching a job to an agent |
| `JobResult` / `JobArtifacts` / `JobOutcome` | Agent's terminal job report |
| `AgentStatusResponse` | Response to `GET /status` on the agent |
| `HealthResponse` | Response to `GET /health` on both services |

### Log bus + SSE log stream (`log-bus.ts`, `sse-log-stream.ts`)

| Export | Description |
|--------|-------------|
| `LogBus` | In-process pub/sub backed by a fixed-size ring buffer; isolates listener exceptions |
| `TeeStream` | Writable stream that JSON-parses pino lines, forwards to `LogBus`, and echoes to stdout |
| `registerSseLogStream(app, bus, opts?)` | Mounts `GET /logs/stream` as an SSE endpoint on a Fastify-compatible app |

### Env parsing (`env.ts`)

| Export | Description |
|--------|-------------|
| `boolFlag(default?)` | Zod transformer: `"0"/"false"/"no"/"off"` → `false`; `"1"/"true"/"yes"/"on"` → `true` |
| `normalizePrivateKey(raw)` | Replaces literal `\n` sequences in PEM strings with real newlines |
| `reportConfigError(err, label?)` | Formats `ZodError` parse failures to stderr; returns `true` if err was a ZodError |

### Repo helpers (`repo.ts`)

| Export | Description |
|--------|-------------|
| `parseRepo(s)` | Parses `"<owner>/<repo>"` → `RepoRef`; throws on malformed input |
| `formatRepo(ref)` | Formats `RepoRef` → `"<owner>/<repo>"` |

### Dependency parsing (`dependencies.ts`)

| Export | Description |
|--------|-------------|
| `parseDependencies(body)` | Extracts `#N` issue numbers from "Depends on / Blocked by / Requires / After" lines in issue bodies |

### Fastify type extension (`fastify-types.ts`)

| Export | Description |
|--------|-------------|
| `ZodFastify` | `FastifyInstance` with `ZodTypeProvider` — the concrete Fastify type passed around both services |

### Version helper (`version.ts`)

| Export | Description |
|--------|-------------|
| `readPackageVersion(callerUrl, levelsUp)` | Reads `version` from a `package.json` relative to `import.meta.url` at runtime |

## Conventions

**Zod-first at boundaries.** Every value crossing a service boundary (HTTP body, database row) has a Zod schema. Schemas are the source of truth; TypeScript types are derived with `z.infer<…>`. When adding a field, add it to the schema first.

**Safe to add, risky to rename.** Four packages depend on every exported symbol. Adding new exports is safe. Renaming or removing one breaks the monorepo build immediately — do it with a cross-package find-and-replace before merging.

**Labels are immutable once routed.** Strings emitted by `routingLabel` and `inProgressLabel` are written to GitHub. Changing their format requires migrating every live label in every watched repo before deploying.

## Build note

`vitest.config.ts` at the monorepo root aliases `@agentify/shared` → `packages/shared/src/index.ts`. You can run the full test suite without first running `pnpm build` in this package — vitest resolves the TypeScript source directly. Production deployments use the compiled `dist/` output via `package.json` exports.
