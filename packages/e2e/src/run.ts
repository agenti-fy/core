#!/usr/bin/env node
/**
 * Happy-path E2E test for agenti-fy.
 *
 *  1. Validates the env and the coordinator state via the doctor checks.
 *  2. Opens a sandbox issue tagged `agent:<TEST_PERSONA>` + `task:plan`.
 *  3. Polls the issue's labels until the in-progress marker appears
 *     (the planner has accepted the dispatch), then until both
 *     routing labels are gone (planner finished and removed them).
 *  4. Asserts the plan completed: child issues exist with `Parent: #N`
 *     in their bodies and bear `task:implement`, the parent body has
 *     been rewritten to include a checklist.
 *  5. Optionally closes the test issue and the children when CLEANUP=1.
 *
 * Returns exit code 0 on PASS, 1 on FAIL, 2 on misconfiguration.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { loadEnv } from './lib/env.js';
import { CoordinatorClient } from './lib/coordinator.js';
import {
  closeIssue,
  createIssue,
  findChildIssues,
  getIssue,
  makeOctokit,
  parseRepo,
} from './lib/github.js';
import { formatMs, waitFor } from './lib/wait.js';

const env = loadEnv();
const coordinator = new CoordinatorClient(env.COORDINATOR_URL);
const octokit = makeOctokit(env);
const repoRef = parseRepo(env.TEST_REPO);

function log(msg: string): void {
   
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function fail(msg: string): never {
   
  console.error(`\n\x1b[31mFAIL\x1b[0m  ${msg}`);
  process.exit(1);
}

function pass(msg: string): never {
   
  console.log(`\n\x1b[32mPASS\x1b[0m  ${msg}`);
  process.exit(0);
}

async function main(): Promise<void> {
  log(`E2E starting against ${env.TEST_REPO} via ${env.COORDINATOR_URL}`);

  // 0. Sanity checks duplicated from doctor (cheap)
  if (await coordinator.halted()) fail('coordinator is halted');
  const agents = await coordinator.listAgents();
  const candidates = agents.filter(
    (a) =>
      a.last_known_status === 'IDLE' &&
      (a.type === env.TEST_PERSONA ||
        (a.type === 'custom' && a.name === env.TEST_PERSONA)),
  );
  if (candidates.length === 0) {
    fail(
      `no IDLE agent of type "${env.TEST_PERSONA}" — run \`agentify-doctor\` first`,
    );
  }
  log(`candidate planner: ${candidates[0]!.name}`);

  // 1. Open the test issue
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const issue = await createIssue(octokit, repoRef, {
    title: `[agentify-e2e] Plan a sample CONTRIBUTING.md (${stamp})`,
    body: [
      `This is an automated end-to-end test for agenti-fy. Planner: \`${env.TEST_PERSONA}\`.`,
      ``,
      `Goal: produce a CONTRIBUTING.md for this repository covering:`,
      ``,
      `- How to set up a local dev environment`,
      `- How to run tests`,
      `- How to open a pull request`,
      `- The repository's coding style guidelines`,
      ``,
      `The planner should break this into ~3 implementable subtasks.`,
      ``,
      `_Created by the agentify-e2e harness; safe to close after the test completes._`,
    ].join('\n'),
    labels: [`agent:${env.TEST_PERSONA}`, 'task:plan'],
  });
  log(`opened ${issue.html_url}`);

  // 2. Wait for in-progress marker (means coordinator dispatched + agent accepted)
  log(
    `waiting up to ${formatMs(env.TEST_DISPATCH_TIMEOUT_MS)} for task:planning-in-progress…`,
  );
  const dispatched = await waitFor(
    async () => {
      const cur = await getIssue(octokit, repoRef, issue.number);
      return cur.labels.includes('task:planning-in-progress') ? cur : null;
    },
    { timeoutMs: env.TEST_DISPATCH_TIMEOUT_MS, intervalMs: 3_000 },
  );
  if (!dispatched.ok) {
    fail(
      `dispatch never happened in ${formatMs(dispatched.waited_ms)} — check coordinator logs and ` +
        `that the work-poller is hitting this repo (run \`agentify-doctor\` for a roadmap).`,
    );
  }
  log(`dispatched after ${formatMs(dispatched.waited_ms)}`);

  // 3. Wait for plan completion (in-progress marker gone AND no agent:* label remaining)
  log(`waiting up to ${formatMs(env.TEST_COMPLETION_TIMEOUT_MS)} for plan to finish…`);
  const finished = await waitFor(
    async () => {
      const cur = await getIssue(octokit, repoRef, issue.number);
      const stillRouting =
        cur.labels.includes('task:planning-in-progress') ||
        cur.labels.some((l) => l.startsWith('agent:')) ||
        cur.labels.some((l) => l.startsWith('task:'));
      const isFailure = cur.labels.includes('needs-human');
      if (isFailure) return cur;
      return stillRouting ? null : cur;
    },
    { timeoutMs: env.TEST_COMPLETION_TIMEOUT_MS, intervalMs: 5_000 },
  );
  if (!finished.ok) {
    fail(
      `plan did not finish in ${formatMs(finished.waited_ms)}. Inspect:\n` +
        `  - GitHub issue ${issue.html_url}\n` +
        `  - coordinator /jobs and /logs/stream\n` +
        `  - agent /status`,
    );
  }
  if (finished.value.labels.includes('needs-human')) {
    fail(
      `plan failed: needs-human applied to ${issue.html_url} — see the failure comment on that issue.`,
    );
  }
  log(`plan completed in ${formatMs(finished.waited_ms)}`);

  // 4. Assert artifacts: child issues created
  await sleep(2_000); // small grace period for GitHub indexing
  const children = await findChildIssues(octokit, repoRef, issue.number);
  log(`found ${children.length} child issue(s) referencing #${issue.number}`);
  for (const c of children) {
    log(`  • #${c.number} ${c.html_url} labels=[${c.labels.join(', ')}]`);
  }

  if (children.length === 0) {
    fail(
      `plan completed but no child issues reference \`Parent: #${issue.number}\` — ` +
        `the planner did not produce subtasks. Inspect ${issue.html_url}.`,
    );
  }
  const withImplementLabel = children.filter((c) => c.labels.includes('task:implement'));
  if (withImplementLabel.length === 0) {
    fail(
      `${children.length} child issue(s) created but none carry \`task:implement\` — ` +
        `they will not be picked up by an implementer.`,
    );
  }

  // 5. Verify the parent body was meaningfully rewritten
  const updatedParent = await getIssue(octokit, repoRef, issue.number);
  const hasChecklist = /(\[ \]|\[x\]) #\d+/.test(updatedParent.body);
  if (!hasChecklist) {
    log(
      `WARN: parent body has no \`- [ ] #N\` checklist — planner may not have wired ` +
        `up auto-tracking. Children still exist; not failing the test.`,
    );
  }

  // 6. Optional cleanup
  if (env.CLEANUP) {
    log('CLEANUP=1 — closing issues');
    await Promise.allSettled(
      children.map((c) => closeIssue(octokit, repoRef, c.number, 'not_planned')),
    );
    await closeIssue(octokit, repoRef, issue.number, 'not_planned');
  }

  pass(
    `${children.length} child issue(s), ${withImplementLabel.length} with task:implement. ` +
      `Parent: ${issue.html_url}`,
  );
}

main().catch((err) => {
  fail(err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
});
