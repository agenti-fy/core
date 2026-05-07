# @agentify/setup

Interactive deployment wizard for agentify. Automates GitHub App creation (via the App Manifest flow), installation, and `.env` generation so operators can go from `git clone` to `docker compose up` without manual click-through.

For the full operator walkthrough, see [`docs/setup-wizard.md`](../../docs/setup-wizard.md).

## Quick start

```sh
pnpm --filter @agentify/setup build
node packages/setup/dist/bin.js
```

Or, after installing the bin globally:

```sh
agentify-setup
```

## Subcommands

| Subcommand | What it does |
|---|---|
| `init` | Start a fresh wizard session. Creates ten GitHub Apps, collects Anthropic credentials, and writes `.env`. |
| `resume` | Continue an interrupted `init` session from the saved checkpoint. |
| `verify` | Read the generated `.env` and verify all credentials are reachable. Does not require the passphrase. |

## Setup-passphrase

The wizard encrypts sensitive secrets — GitHub App PEM private keys, OAuth client secrets, and webhook secrets — before writing them to the checkpoint state file (`~/.config/agentify/setup-<prefix>.json`). The encryption uses a short passphrase you supply; the passphrase is **never** written to disk.

### When you are prompted

| Subcommand | Prompt |
|---|---|
| `init` | Prompted **twice** (with confirmation) to set a new passphrase. Both entries must match. |
| `resume` | Prompted **once** to decrypt the existing checkpoint. |
| `verify` | Not prompted — `verify` reads from `.env`, not the checkpoint file. |

### Requirements

- **Minimum length**: 12 characters. Shorter passphrases are rejected immediately.
- **Confirmation on `init`**: if the two entries do not match, the prompt repeats.

### Headless / CI runs

Set the `AGENTIFY_SETUP_PASSPHRASE` environment variable to bypass the interactive prompt:

```bash
AGENTIFY_SETUP_PASSPHRASE="my-long-passphrase" agentify-setup init
```

> **Caution**: avoid putting the passphrase in shell history (`HISTIGNORE`), CI job logs, or inline in `docker run` commands where it may appear in `ps` output. Prefer a secrets manager that injects it as an env var at runtime.

### Loss recovery

If you forget the passphrase the checkpoint file **cannot be decrypted** — the encrypted values are unrecoverable without the original passphrase.

To start over:

1. Delete the checkpoint: `rm ~/.config/agentify/setup-<prefix>.json`
2. Re-run `agentify-setup init` (and rotate any GitHub App private keys that were already generated).

Alternatively, run `init` with a different `--prefix` value to create a parallel session from scratch.

### Cryptographic design

For the full specification — key derivation parameters (scrypt N=2¹⁴, r=8, p=1), AES-256-GCM nonce and tag handling, per-field salt strategy, and v1 → v2 state migration — see [`docs/adr/001-pem-at-rest-mitigation.md`](../../docs/adr/001-pem-at-rest-mitigation.md).

## See also

- [`docs/setup-wizard.md`](../../docs/setup-wizard.md) — full operator walkthrough
- [`docs/adr/001-pem-at-rest-mitigation.md`](../../docs/adr/001-pem-at-rest-mitigation.md) — ADR for encrypt-at-rest policy
