import {
  PERSONA_DEFAULTS,
  isBuiltinPersona,
  type AgentRecord,
  type JobRecord,
  type RepoRecord,
} from '@agenti-fy/shared';
import { CoordinatorApi } from './api.js';

export interface StatusSnapshot {
  coordinator: string;
  halted: boolean;
  fetched_at: string;
  agents: AgentRecord[];
  open_jobs: JobRecord[];
  repos: RepoRecord[];
  counts: { IDLE: number; BUSY: number; FAILURE: number; UNKNOWN: number };
}

export async function snapshot(coordinatorUrl: string): Promise<StatusSnapshot> {
  const api = new CoordinatorApi(coordinatorUrl);
  const [agents, jobs, repos, halted] = await Promise.all([
    api.listAgents(),
    api.listJobs(),
    api.listRepos(),
    api.getHalt(),
  ]);
  const counts = { IDLE: 0, BUSY: 0, FAILURE: 0, UNKNOWN: 0 };
  for (const a of agents) {
    const s = a.last_known_status;
    if (s === 'IDLE' || s === 'BUSY' || s === 'FAILURE') counts[s]++;
    else counts.UNKNOWN++;
  }
  return {
    coordinator: coordinatorUrl,
    halted,
    fetched_at: new Date().toISOString(),
    agents,
    open_jobs: jobs,
    repos,
    counts,
  };
}

export function renderText(snap: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push(`coordinator: ${snap.coordinator}`);
  lines.push(`halt: ${snap.halted ? 'ON' : 'off'}    fetched: ${snap.fetched_at}`);
  lines.push(
    `agents: IDLE=${snap.counts.IDLE} BUSY=${snap.counts.BUSY} FAILURE=${snap.counts.FAILURE}` +
      (snap.counts.UNKNOWN > 0 ? ` UNKNOWN=${snap.counts.UNKNOWN}` : ''),
  );
  lines.push(`jobs: open=${snap.open_jobs.length}`);
  lines.push(`repos: managed=${snap.repos.length}`);
  lines.push('');
  if (snap.agents.length === 0) {
    lines.push('  (no agents registered)');
  } else {
    lines.push('AGENTS');
    for (const a of snap.agents) {
      const emoji = isBuiltinPersona(a.type) ? PERSONA_DEFAULTS[a.type].emoji : '*';
      const status = a.last_known_status ?? '—';
      const job = snap.open_jobs.find((j) => j.agent_id === a.agent_id);
      const work = job ? ` [${job.method} @ ${job.repo}#${job.target_id}]` : '';
      lines.push(
        `  ${emoji} ${pad(a.type, 14)} ${pad(a.name, 22)} ${pad(status, 8)}${work}`,
      );
    }
  }
  if (snap.open_jobs.length > 0) {
    lines.push('');
    lines.push('OPEN JOBS');
    for (const j of snap.open_jobs) {
      lines.push(
        `  ${pad(j.status, 12)} ${pad(j.method, 14)} ${pad(`${j.repo}#${j.target_id}`, 30)} ${j.job_id}`,
      );
    }
  }
  if (snap.repos.length > 0) {
    lines.push('');
    lines.push('REPOS');
    for (const r of snap.repos) {
      lines.push(
        `  ${pad(r.repo, 38)} ${pad(r.active ? 'active' : 'paused', 8)} every ${r.poll_interval_s}s`,
      );
    }
  }
  return lines.join('\n') + '\n';
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
