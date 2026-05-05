import React from 'react';
import { Box, Text } from 'ink';
import {
  PERSONA_DEFAULTS,
  isBuiltinPersona,
  type AgentRecord,
  type JobRecord,
} from '@agentify/shared';
import type { AppState } from '../store.js';

interface Props {
  state: AppState;
}

export function Dashboard({ state }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold underline>AGENTS</Text>
      <Box flexDirection="column" marginBottom={1}>
        {state.agents.length === 0 ? (
          <Text dimColor>(none registered)</Text>
        ) : (
          state.agents.map((a) => <AgentRow key={a.agent_id} agent={a} jobs={state.jobs} />)
        )}
      </Box>
      <Text bold underline>OPEN JOBS</Text>
      <Box flexDirection="column">
        {state.jobs.length === 0 ? (
          <Text dimColor>(none)</Text>
        ) : (
          state.jobs.slice(0, 10).map((j) => <JobRow key={j.job_id} job={j} agents={state.agents} />)
        )}
      </Box>
    </Box>
  );
}

interface AgentRowProps {
  agent: AgentRecord;
  jobs: readonly JobRecord[];
}

function AgentRow({ agent, jobs }: AgentRowProps): React.ReactElement {
  const emoji = isBuiltinPersona(agent.type) ? PERSONA_DEFAULTS[agent.type].emoji : '✨';
  const currentJob = jobs.find((j) => j.agent_id === agent.agent_id);
  const status = agent.last_known_status ?? '—';
  const statusColor = status === 'IDLE' ? 'green' : status === 'BUSY' ? 'yellow' : status === 'FAILURE' ? 'red' : 'gray';
  return (
    <Box>
      <Box width={3}>
        <Text>{emoji}</Text>
      </Box>
      <Box width={14}>
        <Text>{agent.type}</Text>
      </Box>
      <Box width={20}>
        <Text dimColor>{agent.name}</Text>
      </Box>
      <Box width={10}>
        <Text color={statusColor} bold>{status}</Text>
      </Box>
      <Box flexGrow={1}>
        {currentJob ? (
          <Text>
            <Text color="cyan">{currentJob.method}</Text>
            <Text> @ {currentJob.repo}#{currentJob.target_id}</Text>
          </Text>
        ) : (
          <Text dimColor>—</Text>
        )}
      </Box>
    </Box>
  );
}

interface JobRowProps {
  job: JobRecord;
  agents: readonly AgentRecord[];
}

function JobRow({ job, agents }: JobRowProps): React.ReactElement {
  const agent = agents.find((a) => a.agent_id === job.agent_id);
  const elapsed = formatElapsed(Date.now() - job.dispatched_at);
  return (
    <Box>
      <Box width={14}>
        <Text color={job.status === 'running' ? 'yellow' : 'cyan'}>{job.status}</Text>
      </Box>
      <Box width={16}>
        <Text>{job.method}</Text>
      </Box>
      <Box width={28}>
        <Text dimColor>{job.repo}#{job.target_id}</Text>
      </Box>
      <Box width={18}>
        <Text dimColor>{agent?.name ?? job.agent_id.slice(-8)}</Text>
      </Box>
      <Text dimColor>{elapsed}</Text>
    </Box>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
