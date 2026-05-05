/**
 * Standalone smoke test for the dispatcher → completion-poller round-trip
 * without GitHub. Spawns nothing on its own — expects:
 *
 *   - a coordinator DB at $DATA_DIR (default /tmp/agentify-dispatch-smoke)
 *   - an agent already registered with the coordinator at $AGENT_URL
 *
 * Run after `pnpm build` like:
 *
 *   GITHUB_APP_ID=x GITHUB_APP_PRIVATE_KEY=x GITHUB_APP_INSTALLATION_ID=x \
 *   GITHUB_USER=x DISABLE_GITHUB=1 DATA_DIR=/tmp/agentify-dispatch-smoke \
 *   AGENT_URL=http://localhost:18081 \
 *   node packages/coordinator/dist/__smoke__/dispatch-roundtrip.js
 *
 * Exits non-zero on failure.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import pino from 'pino';
import { loadConfig } from '../config.js';
import { CoordinatorStore } from '../store.js';
import { AgentRpcClient } from '../agent-client.js';
import { dispatchBatch } from '../dispatch/index.js';
import { pollJobCompletions } from '../poller/job-poller.js';
import type { PendingWorkItem } from '../poller/work-poller.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: 'info', base: { service: 'dispatch-smoke' } });
  const store = new CoordinatorStore(join(config.dataDir, 'coordinator.db'));
  const agentClient = new AgentRpcClient();

  const agents = store.listAgents();
  if (agents.length === 0) {
    throw new Error('no registered agents — start an agent first');
  }
  const target = agents.find((a) => a.type === 'tinkerer') ?? agents[0]!;
  logger.info({ agent: target.name, url: target.url }, 'using registered agent');

  // Make sure the heartbeat shows IDLE so the picker matches.
  store.recordHeartbeat(target.agent_id, 'IDLE');

  const item: PendingWorkItem = {
    repo: 'acme/api',
    target_id: 4242,
    persona: target.type,
    persona_name: target.type === 'custom' ? target.name : target.type,
    method: 'plan',
  };

  const summary = await dispatchBatch([item], { store, agentClient, logger });
  logger.info({ summary }, 'dispatch complete');
  if (summary.dispatched !== 1) {
    throw new Error(`expected 1 dispatched, got ${summary.dispatched}`);
  }

  // Stub agent finishes the job near-instantly. Poll until coordinator records it.
  const deadline = Date.now() + 5000;
  let final;
  while (Date.now() < deadline) {
    await sleep(250);
    await pollJobCompletions({ store, agentClient, logger });
    final = store.listOpenJobs();
    if (final.length === 0) break;
  }
  const open = store.listOpenJobs();
  if (open.length !== 0) {
    throw new Error(`expected no open jobs, found ${open.length}`);
  }

  logger.info('round-trip OK');
  store.close();
}

main().catch((err) => {
   
  console.error('FAIL:', err);
  process.exit(1);
});
