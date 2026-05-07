# Setup wizard

Interactive operator walkthrough for the `agentify-setup` wizard. The wizard
creates ten GitHub Apps (one coordinator + nine per-persona), installs each on
your target repository, collects your Anthropic credentials, and writes a
ready-to-use `.env` file.

This replaces the manual click-through described in
[`README.md` § GitHub App setup](../README.md#github-app-setup).

---

## Contents

- [Prerequisites](#prerequisites)
- [Run the wizard](#run-the-wizard)
- [What it does, step by step](#what-it-does-step-by-step)
- [Resuming an interrupted run](#resuming-an-interrupted-run)
- [Verifying](#verifying)
- [Headless / scripted setups](#headless--scripted-setups)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| # | Requirement | Check |
|---|-------------|-------|
| 1 | **`gh` CLI installed and authenticated** | `gh auth status` exits 0 |
| 2 | **Target repository exists and is accessible** | `gh repo view owner/name` succeeds |
| 3 | **Anthropic auth source ready** | An `ANTHROPIC_API_KEY` (`sk-ant-*`) **or** a `CLAUDE_CODE_OAUTH_TOKEN` |
| 4 | **Browser reachable** | GitHub's App Manifest flow requires one click per App — see [headless setups](#headless--scripted-setups) for air-gapped machines |

The wizard validates `gh auth status` on entry and prints a clear error if the
CLI is not authenticated.

---

## Run the wizard

### From the source tree (pre-publish)

```sh
pnpm --filter @agentify/setup build
pnpm --filter @agentify/setup start init
```

Pass flags without the interactive prompts:

```sh
pnpm --filter @agentify/setup start -- init --prefix myorg --repo acme/sandbox
```

### After publish (once `@agentify/setup` is on npm)

```sh
npx -y @agentify/setup init
```

Available flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--prefix <s>` | prompted | App-name prefix (e.g. `"myorg"`). Must match `^[a-z0-9][a-z0-9-]{0,20}$` (max 21 chars). |
| `--repo <owner/name>` | prompted | Target repository. |
| `--dry-run` | `false` | Print the generated `.env` to stdout; do not write to disk. |
| `--env-out <path>` | `<cwd>/.env` | Write the `.env` to an explicit path. |
| `--state-file <path>` | `~/.config/agentify/setup-<prefix>.json` | Override the checkpoint file location. |

---

## What it does, step by step

### 1 — Preamble

Checks `gh auth status`, prompts for the **App-name prefix** and **target
repo**, then infers whether the owner is a personal account or organisation.
State is checkpointed to `~/.config/agentify/setup-<prefix>.json` before the
first browser window opens.

**Prefix constraint:** `<prefix>-orchestrator` (the longest App name) must not
exceed 34 characters — so the prefix may be at most 21 characters.

### 2 — Per-persona App creation (×10)

Apps are created in order: **coordinator** (uses global `GITHUB_APP_*` env
keys), then **orchestrator**, **conductor**, **theorist**, **tinkerer**,
**optimizer**, **glue**, **skeptic**, **crafter**, **scribe** (one per
built-in persona, each using `<PERSONA>_GITHUB_APP_*` env keys).

For each App the wizard:

1. Builds a [GitHub App Manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
   and opens a local HTTP server on a random port for the OAuth callback.
2. Opens a browser to the GitHub manifest form.
   <!-- screenshot: github-create-app.png placeholder -->
3. **You click "Create GitHub App"** (the only manual step per App).
4. GitHub redirects back; the wizard exchanges the code for `id`, `pem`,
   `client_id`, `client_secret`, and `webhook_secret`.
5. An installation URL opens; **you install the App on the target repo**.
   <!-- screenshot: github-install-app.png placeholder -->
6. The wizard polls `GET /app/installations` until the `installation_id`
   appears, then checkpoints it.

Permissions set automatically via the manifest (matching
[`README.md` § GitHub App setup](../README.md#github-app-setup)):
**Contents R/W, Issues R/W, Pull requests R/W, Metadata R, Wiki R/W**.

### 3 — Anthropic auth + tunables

```
?  Anthropic auth … (•) ANTHROPIC_API_KEY  ( ) CLAUDE_CODE_OAUTH_TOKEN
?  Paste your Anthropic API key › ••••••••

?  Log level (LOG_LEVEL)                      [info]:
?  GitHub poll interval in s (WORK_POLL_S)    [30]:
?  Per-job cost ceiling in USD (CLAUDE_COST_LIMIT_USD) [5.0]:
```

The Anthropic secret is held only in memory — it is **never written** to the
checkpoint file. `agentify-setup resume` re-prompts for it.

### 4 — Finalize

Renders all credentials into `.env` (mode `0600`) at `<cwd>/.env`. If the
file already exists you are offered three choices: overwrite, write alongside
as `.env.new`, or abort. On success:

```
✔ Wrote .env (43 vars, 6.2 KiB)

── Next steps ───────────────────────────────
  docker compose up -d --build
  pnpm e2e:doctor
```

---

## Resuming an interrupted run

Any abort (Ctrl-C, closed browser, network drop) is safe. The wizard
checkpoints after each step:

```
~/.config/agentify/setup-<prefix>.json   (mode 0600)
```

To continue:

```sh
agentify-setup resume
# or with a known prefix:
agentify-setup resume --prefix myorg
```

Already-created Apps are reused from the checkpoint; only missing personas
are re-entered. The Anthropic secret is re-prompted because it is excluded
from the checkpoint.

---

## Verifying

After the run — or to cross-check an existing `.env` at any time:

```sh
agentify-setup verify
# explicit path:
agentify-setup verify --env-out /etc/agentify/.env
```

The `verify` subcommand runs a doctor-style checklist:

- **Structural** — all required env vars are present and non-empty.
- **PEM** — every `*_GITHUB_APP_PRIVATE_KEY` has matching `BEGIN`/`END` headers.
- **API** — `GET /app` (JWT auth) succeeds for each of the ten Apps.
- **Installation** — `GET /app/installations/{id}` is live for each.

Exits `0` when all checks pass; `1` otherwise.

For a broader system health check after `docker compose up`:

```sh
pnpm e2e:doctor
```

---

## Headless / scripted setups

The wizard is **not** the only path. Air-gapped operators or CI environments
can hand-roll the `.env` by following the manual instructions in
[`README.md` § GitHub App setup](../README.md#github-app-setup) and the full
env block in [`docker-compose.yml`](../docker-compose.yml).

The `--dry-run` flag generates a preview without writing to disk:

```sh
agentify-setup init --dry-run
```

---

## Troubleshooting

### Browser didn't open

The wizard prints the manifest URL. Copy it to any browser that can reach
`github.com`:

```
Opening browser: https://github.com/settings/apps/new?state=…
If it did not open, paste the URL above into a browser, then press Enter.
```

---

### "Manifest code expired" (404 on exchange)

GitHub manifest codes expire quickly (~10 minutes). The wizard discards the
failed persona, resets the browser step, and retries. No state is lost.
Related: [#423](https://github.com/agenti-fy/core/issues/423).

---

### "Installation didn't appear"

1. Confirm the App was installed on **the same owner/org** as the target repo.
2. Run `gh api /app/installations` (App-JWT-authenticated) to list active
   installations manually.
3. If found, run `agentify-setup resume` — the poller picks it up on the
   next cycle.

---

### "Apps already exist with this prefix"

Either **resume** the existing session (`agentify-setup resume --prefix
<prefix>`) or start fresh with a different prefix.

---

### "GitHub App name too long"

The wizard enforces a prefix of at most **21 characters** so that
`<prefix>-orchestrator` stays within GitHub's 34-character display cap.
Shorten the prefix and retry. See [#420](https://github.com/agenti-fy/core/issues/420).
