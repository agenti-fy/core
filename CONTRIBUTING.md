# Contributing

Thanks for contributing. This guide covers the mechanics of working in this repo — setup,
development loop, conventions. For system architecture, see the [README](README.md); for the
technical specification, see [SPEC.md](SPEC.md).

---

## Prerequisites

- **Node 22+** — `.nvmrc` pins `22`; `package.json` enforces `>=22.0.0`.
- **pnpm 9+** — `package.json` enforces `>=9.0.0`; the repo's `packageManager` is `pnpm@10.20.0`.

If you use nvm, running `nvm install && nvm use` in the repo root will pick up the right version.

---

## Workspace layout

The repo is a pnpm workspace (`pnpm-workspace.yaml`) with five packages under `packages/`:

```
packages/
  shared/        Zod schemas, label/method constants, log bus, RPC types
  coordinator/   Fastify + SQLite + GitHub poller + dispatcher
  agent/         Fastify + Claude Agent SDK + per-job git worktree
  tui/           Ink-based terminal dashboard
  e2e/           Doctor + happy-path E2E harness
```

`shared` is a build-time dependency of every other package. `pnpm typecheck` and `pnpm test`
pick up `shared` changes without a prior build — project-references mode and the vitest alias
handle this respectively (see [Iterating](#iterating)). Only `pnpm start` requires a prior
rebuild: `pnpm --filter @agentify/shared build`.

---

## Setup

Clone the repo, install, and verify a clean build:

```sh
pnpm install       # install all workspace deps
pnpm build         # compile every package (tsc)
pnpm typecheck     # type-check (project-references build mode)
pnpm test          # vitest run — no network or live services required
```

All four commands should exit 0. `pnpm typecheck` and `pnpm test` succeed on a fresh clone
without a prior `pnpm build` — only `pnpm start` requires built output. If `pnpm build` fails,
check that your Node version is ≥ 22.

> **Note on `pnpm typecheck` and `dist/` artifacts:** `pnpm typecheck` runs `tsc -b` (TypeScript
> project-references build mode). Because each package is configured with `"composite": true`,
> `tsc -b` emits a full build into each package's `dist/` directory — JavaScript, declaration
> files, source maps, and a `dist/.tsbuildinfo` incremental cache. These files are expected and
> should not be committed; `dist/`, `.tsbuildinfo`, and `*.tsbuildinfo` are all covered by
> `.gitignore`. If you suspect a stale `.tsbuildinfo` is masking a real type error locally, run
> `pnpm clean` to wipe the caches, then re-run `pnpm typecheck`.

To wipe compiled output and caches and start fresh:

```sh
pnpm clean         # rm -rf dist + node_modules/.cache across all packages
pnpm install && pnpm build
```

---

## Iterating

**Per-package dev mode** — each package has a `dev` script that watches source and recompiles on
change. To run all packages in parallel:

```sh
pnpm dev           # pnpm -r --parallel dev
```

To target a single package:

```sh
pnpm --filter @agentify/coordinator dev
```

**Test watch mode** — vitest's interactive mode for rapid iteration:

```sh
pnpm test:watch    # vitest (interactive watch)
```

Test files are picked up from `packages/*/src/**/*.test.ts` and `packages/*/test/**/*.test.ts`.

**`@agentify/shared` source alias** — `vitest.config.ts` maps the `@agentify/shared` import to
`packages/shared/src/index.ts` directly, so tests always exercise current source without needing a
prior `pnpm build` for the shared package. This alias is vitest-only; the coordinator and agent
runtimes follow normal `dist/` resolution at startup.

---

## Linting & formatting

```sh
pnpm lint          # eslint .
pnpm format        # prettier --write .
pnpm format:check  # prettier --check . (what CI runs)
```

**ESLint** — `eslint.config.js` builds on `typescript-eslint recommendedTypeChecked`. A handful of
rules are intentionally disabled with inline rationale; read the config before adding overrides:

- `no-unsafe-*` rules: off because Zod parses at the system boundary and narrows with `as` casts
  — the rules would fire on every schema result.
- `require-await`: off because Fastify handlers and test mocks use `async` signatures for
  consistency even when the body is synchronous.
- `restrict-template-expressions`: off to allow `${err}` / `String(err)` on caught `unknown`.
- Test files additionally disable `unbound-method` to avoid false positives on spy/mock helpers.

`eslint.config.js` and `vitest.config.ts` are excluded from the project service (they're not part
of any tsconfig project); don't add them to a tsconfig.

**Prettier** — config is in `.prettierrc.json`: single quotes, trailing commas everywhere,
100-character print width, 2-space indent. `.prettierignore` excludes `dist/`, `node_modules/`,
`pnpm-lock.yaml`, and `*.md` — markdown is not auto-formatted.

**EditorConfig** — `.editorconfig` enforces LF line endings, 2-space indent, UTF-8, and a final
newline for all files. If your editor supports EditorConfig, it will apply these automatically.

---

## Commit & PR conventions

This repo follows [Conventional Commits](https://www.conventionalcommits.org/) with a compact
`type: subject` format:

```
feat: add GitHub App webhook validation
fix: correct label parse for combined agent:persona:method form
docs: add CONTRIBUTING.md
refactor: extract worktree cleanup into helper function
test: add coordinator dispatch smoke test
chore: bump vitest to 2.2
```

Rules inferred from the existing commit history:

- **Lowercase subject**, no trailing period.
- **Imperative mood** — "Add X", not "Added X" or "Adding X".
- **No scope prefix required** unless the change is fully contained within one package, in which
  case `fix(coordinator): ...` is acceptable but not mandatory.
- **One logical change per commit.** If you're touching both a bug fix and a refactor, split them.

PR titles follow the same `type: subject` format as the primary commit. Link the issue in the PR
body (`Closes #N`). Describe what changed, why, and how to verify it — the diff shows the what,
the description explains the why.

---

## Architectural decisions

Significant design choices — anything that locks in a contract or introduces a hard-to-reverse
change — are recorded as ADRs in `docs/adr/NNN-<slug>.md`. See
[docs/adr/001-pem-at-rest-mitigation.md](docs/adr/001-pem-at-rest-mitigation.md) for an example
of the expected header and body format.

If your PR makes a structural or hard-to-reverse decision (new protocol, data schema, security
boundary, public API surface), add an ADR alongside the code change.

---

## Adding a persona

See the [Adding a new persona](README.md#adding-a-new-persona) section in the root README. Drop a
new SOUL.md in `souls/`, add a service block in `docker-compose.yml`, and route an issue to the
new persona. Don't duplicate those steps here.

---

## Running E2E

The full setup is in [`packages/e2e/README.md`](packages/e2e/README.md). The short form:

```sh
pnpm e2e:doctor                          # pre-flight: env, coordinator, agent, GitHub App
TEST_REPO=your-org/sandbox \
TEST_PERSONA=orchestrator \
CLEANUP=1 \
  pnpm e2e:run                           # happy-path test
```

E2E tests hit a real GitHub App installation and a real Anthropic API key. They are not part of
the standard `pnpm test` pass and are not expected to run in a clean dev environment without the
full service stack running.

---

## Reporting bugs

Open a GitHub issue and include:

- **A one-line summary** as the issue title.
- **Steps to reproduce** — what you did, what you expected, what happened.
- **Logs** — coordinator and agent logs are JSON-structured; pipe through `jq` for readability.
- **Environment** — Node version (`node --version`), pnpm version (`pnpm --version`), and the
  commit or tag you're running.

Apply the `bug` label. If you've traced the issue to a specific package, mention that in the body.
