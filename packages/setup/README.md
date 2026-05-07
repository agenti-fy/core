# @agentify/setup

Interactive deployment wizard for agentify. Automates GitHub App creation (via the App Manifest flow), installation, and `.env` generation so operators can go from `git clone` to `docker compose up` without manual click-through.

For the full operator walkthrough, see [`docs/setup-wizard.md`](../../docs/setup-wizard.md) (landing in a later task).

## Quick start

```sh
pnpm --filter @agentify/setup build
node packages/setup/dist/bin.js
```

Or, after installing the bin globally:

```sh
agentify-setup
```
