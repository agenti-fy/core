#!/usr/bin/env node
/**
 * Pre-flight check for the E2E suite. Validates env, coordinator reachability,
 * agent registration, GitHub App auth, and target repo accessibility.
 *
 * Exits 0 if everything looks healthy, 1 otherwise. Prints a checklist with
 * each step's pass/fail and a one-line hint when something is off.
 */
import { loadEnv } from './lib/env.js';
import { CoordinatorClient } from './lib/coordinator.js';
import { ensureRepoAccessible, makeOctokit, parseRepo } from './lib/github.js';

interface Check {
  name: string;
  fn: () => Promise<string | null>;
}

const env = loadEnv();
const coordinator = new CoordinatorClient(env.COORDINATOR_URL);
const octokit = makeOctokit(env);
const repoRef = parseRepo(env.TEST_REPO);

const checks: Check[] = [
  {
    name: `coordinator reachable at ${env.COORDINATOR_URL}`,
    fn: async () => {
      const h = await coordinator.health();
      return `service=${h.service} version=${h.version} uptime=${h.uptime_s}s`;
    },
  },
  {
    name: 'coordinator is not halted',
    fn: async () => {
      const halted = await coordinator.halted();
      if (halted) return 'FAIL: coordinator is halted (POST /resume to clear)';
      return 'halt: off';
    },
  },
  {
    name: `at least one IDLE agent matches persona "${env.TEST_PERSONA}"`,
    fn: async () => {
      const agents = await coordinator.listAgents();
      const matching = agents.filter(
        (a) =>
          a.last_known_status === 'IDLE' &&
          (a.type === env.TEST_PERSONA ||
            (a.type === 'custom' && a.name === env.TEST_PERSONA)),
      );
      if (matching.length === 0) {
        return `FAIL: no IDLE agent of type "${env.TEST_PERSONA}" registered (registered: ${agents
          .map((a) => `${a.name}(${a.type}/${a.last_known_status ?? '—'})`)
          .join(', ')})`;
      }
      return `${matching.length} candidate agent(s): ${matching.map((a) => a.name).join(', ')}`;
    },
  },
  {
    name: `GitHub App installation can read ${env.TEST_REPO}`,
    fn: async () => {
      try {
        const info = await ensureRepoAccessible(octokit, repoRef);
        return `default_branch=${info.default_branch} permissions=${info.permissions.join('+') || '?'}`;
      } catch (err) {
        return `FAIL: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  {
    name: `coordinator's repo poller knows about ${env.TEST_REPO}`,
    fn: async () => {
      const repos = await coordinator.listRepos();
      const found = repos.find((r) => r.repo === env.TEST_REPO);
      if (!found) {
        return (
          `WARN: ${env.TEST_REPO} not yet in coordinator.repos table — it will be ` +
          `discovered on the next installation refresh (default 5min). Test will still ` +
          `work once it's discovered, or you can wait for the next tick.`
        );
      }
      return `active=${found.active} every=${found.poll_interval_s}s last_polled=${
        found.last_polled ? `${Math.round((Date.now() - found.last_polled) / 1000)}s ago` : 'never'
      }`;
    },
  },
  {
    name: 'ANTHROPIC_API_KEY is set on the agent (presence only — value not validated)',
    fn: async () => {
      // We can't reach inside the agent process; just mention what we expect.
      return env.ANTHROPIC_API_KEY.startsWith('sk-ant-')
        ? 'looks like a real key prefix'
        : 'WARN: key does not start with "sk-ant-" — re-check ANTHROPIC_API_KEY';
    },
  },
];

let failed = 0;
for (const check of checks) {
  process.stdout.write(`• ${check.name} ... `);
  try {
    const result = await check.fn();
    if (result && result.startsWith('FAIL')) {
      failed++;
       
      console.log(`\x1b[31mFAIL\x1b[0m\n    ${result}`);
    } else if (result && result.startsWith('WARN')) {
       
      console.log(`\x1b[33mWARN\x1b[0m\n    ${result.replace(/^WARN:?\s*/, '')}`);
    } else {
       
      console.log(`\x1b[32mok\x1b[0m  ${result ?? ''}`);
    }
  } catch (err) {
    failed++;
     
    console.log(`\x1b[31mERROR\x1b[0m\n    ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failed > 0) {
   
  console.log(`\n${failed} check(s) failed.`);
  process.exit(1);
}
 
console.log('\nAll checks passed. Ready to run `agentify-e2e`.');
