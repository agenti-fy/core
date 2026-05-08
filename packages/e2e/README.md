# @agenti-fy/e2e

End-to-end test harness for agenti-fy. Runs against a real GitHub App installation, a real Anthropic API key, and a running coordinator + at least one agent.

The harness ships two binaries:

- `agentify-doctor` — pre-flight checks. Validates env, coordinator reachability, agent registration, GitHub App auth, and target repo accessibility. Run this first.
- `agentify-e2e` — the happy-path test. Opens a sandbox issue, watches the planner work it, and asserts that child issues with `task:implement` were created.

## 1. Pre-requisites

You will need:

1. A GitHub App you control, installed on a sandbox repo (the test only writes to that one repo).
2. The App's id, private key (PEM), installation id, and the bot login it impersonates.
3. An Anthropic API key (`sk-ant-…`).
4. A running coordinator + at least one IDLE agent of the persona named in `TEST_PERSONA`.

### 1.1 Create the GitHub App

In `Settings → Developer settings → GitHub Apps → New GitHub App`:

| Setting | Value |
|---|---|
| **Homepage URL** | anything; not used |
| **Webhook → Active** | **off** (we poll, no webhook needed) |
| **Repository permissions → Contents** | Read & write |
| **Repository permissions → Issues** | Read & write |
| **Repository permissions → Pull requests** | Read & write |
| **Repository permissions → Metadata** | Read |
| **Where can this be installed?** | Only on this account |

After saving:

1. Note the **App ID** (top of the App settings page).
2. **Generate a private key** (bottom of the same page) → downloads a `.pem`.
3. Click **Install App** in the left sidebar → choose your sandbox repo only → after install, the URL becomes `…/installations/<INSTALLATION_ID>`. Note that id.
4. The bot login is `<your-app-name>[bot]` (visible on issues/PRs the App opens).

### 1.2 Create the sandbox repo

A throw-away private repo is fine. Add at least a README so the default branch exists. Make sure your App is installed on that repo.

## 2. Configure env

Create `.env.e2e` at the repo root. The harness loads from `process.env`, so source it before running.

```bash
# .env.e2e
export GITHUB_APP_ID=123456
export GITHUB_APP_PRIVATE_KEY="$(cat /path/to/your-app.private-key.pem)"
export GITHUB_APP_INSTALLATION_ID=789012
export GITHUB_USER='your-app-name[bot]'

export ANTHROPIC_API_KEY=sk-ant-…

# Sandbox repo to write into.
export TEST_REPO=your-org/agentify-sandbox

# Coordinator + which persona should pick up the test issue.
export COORDINATOR_URL=http://localhost:8080
export TEST_PERSONA=orchestrator

# Optional: set to 1 to close the test issue + children after the test passes.
export CLEANUP=0

# Optional: tighten/loosen timeouts.
export TEST_DISPATCH_TIMEOUT_MS=120000     # default 2min
export TEST_COMPLETION_TIMEOUT_MS=600000   # default 10min
```

> **Multi-line private key in shell**
> If you don't want command substitution, you can paste the PEM as a single line with `\n` placeholders. The agent and coordinator both translate `\n` → real newlines.

## 3. Bring up the stack

Either docker-compose with the full team:

```bash
source .env.e2e
docker compose up -d coordinator orchestrator
```

…or run the two services as plain Node processes during development:

```bash
# Terminal 1 — coordinator
source .env.e2e
DATA_DIR=./.data PORT=8080 \
  node packages/coordinator/dist/index.js | pino-pretty

# Terminal 2 — orchestrator agent
source .env.e2e
AGENT_PORT=8081 \
  COORDINATOR_URL=http://localhost:8080 \
  AGENT_PUBLIC_URL=http://localhost:8081 \
  SOUL_PATH=./souls/orchestrator.md \
  WORKSPACES_DIR=./.workspaces \
  node packages/agent/dist/index.js | pino-pretty
```

> The agent's Claude adapter auto-selects: with `ANTHROPIC_API_KEY` set, it picks `LiveClaudeAdapter` (real SDK). Without it, the stub adapter runs and the test will still PASS but the planner won't actually create real child issues — useful for harness debugging only.

## 4. Run the doctor

```bash
source .env.e2e
node packages/e2e/dist/doctor.js
```

A clean run looks like:

```
• coordinator reachable at http://localhost:8080 ... ok  service=coordinator version=0.1.0 uptime=15s
• coordinator is not halted ... ok  halt: off
• at least one IDLE agent matches persona "orchestrator" ... ok  1 candidate agent(s): orchestrator
• GitHub App installation can read your-org/agentify-sandbox ... ok  default_branch=main permissions=admin+push+pull
• coordinator's repo poller knows about your-org/agentify-sandbox ... ok  active=1 every=30s last_polled=12s ago
• ANTHROPIC_API_KEY is set on the agent (presence only — value not validated) ... ok  looks like a real key prefix

All checks passed. Ready to run `agentify-e2e`.
```

If the repo-poller check WARNs that the repo isn't yet known, wait up to 5 minutes for the coordinator's installation refresh and re-run.

## 5. Run the test

```bash
source .env.e2e
node packages/e2e/dist/run.js
```

Expected timeline (real Anthropic + real GitHub):

```
[…] E2E starting against your-org/agentify-sandbox via http://localhost:8080
[…] candidate planner: orchestrator
[…] opened https://github.com/your-org/agentify-sandbox/issues/42
[…] waiting up to 2m for task:planning-in-progress…
[…] dispatched after 8.2s
[…] waiting up to 10m for plan to finish…
[…] plan completed in 1m17s
[…] found 3 child issue(s) referencing #42
[…]   • #43 https://…/issues/43 labels=[agent:tinkerer, task:implement]
[…]   • #44 https://…/issues/44 labels=[agent:tinkerer, task:implement]
[…]   • #45 https://…/issues/45 labels=[agent:scribe, task:implement]

PASS  3 child issue(s), 3 with task:implement. Parent: https://github.com/your-org/agentify-sandbox/issues/42
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | PASS |
| `1` | FAIL — assertion failed or timeout. The GitHub URL in the output points at the actual artifacts you can inspect. |
| `2` | misconfiguration — env failed to validate; the message lists which keys |

## 6. Watching it live

In another terminal you can run the dashboard for a real-time view:

```bash
source .env.e2e
node packages/tui/dist/index.js --coordinator $COORDINATOR_URL
```

`l` opens the Logs screen, `j` shows the open job, `a` shows the agent's status.

For a one-shot snapshot (CI-friendly):

```bash
node packages/tui/dist/index.js status --coordinator $COORDINATOR_URL --json
```

## 7. Cleanup

By default the test leaves the issues open so you can inspect them. To auto-close:

```bash
CLEANUP=1 node packages/e2e/dist/run.js
```

This closes the parent (state_reason: `not_planned`) and every child it created. Branches and PRs (when those phases are exercised in future tests) are not auto-cleaned.

## 8. What this test does NOT do (yet)

- It exercises **only the Plan phase**. The Implement / Review / AddressReview / Merge cycle is not yet driven end-to-end by the harness. Those skills run in production but are non-deterministic against the live model and we want a stable assertion target for v1.
- It does not assert that the model produced "good" plans — only that it produced some plans (≥1 child issue with `task:implement`).
- It does not start or stop the coordinator/agents — bring them up yourself.
- It does not validate Anthropic API connectivity directly. If the planner ends up posting a `needs-human` failure comment, that's typically the cause; check the issue.

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Doctor: "GitHub App installation can read X — FAIL: Invalid keyData" | Private key not loaded correctly. If using `\n` placeholders, ensure they're literal. If reading from a file, use `$(cat …)` or pass the multi-line value through `.env`. |
| Doctor: "no IDLE agent of type 'orchestrator'" | The agent didn't register or its persona doesn't match. Check the agent's logs and confirm SOUL.md `type:` matches `TEST_PERSONA`. |
| Test: timeout waiting for `task:planning-in-progress` | Either the coordinator's work-poller hasn't seen this repo (run doctor again, wait for installation refresh), or the agent rejected the dispatch (check `/agents/<id>` and `/jobs`). |
| Test: plan ended with `needs-human` | The planner's run hit a `task_error` (skill error or GH push error). The issue's most recent comment from the bot has the error text. |
| Test: plan completed but 0 child issues | The model did not invoke `gh issue create` (or its equivalent). Inspect the parent issue body — the model may have written the plan inline without the bash side-effect. SOUL prompts are tunable; consider adding hard-rules in your SOUL.md. |
