import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../store.js';
import type { JobRecord } from '@agentify/shared';

export function Jobs({ state }: { state: AppState }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold underline>OPEN JOBS</Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {state.jobs.length === 0 ? (
          <Text dimColor>(none)</Text>
        ) : (
          state.jobs.map((j) => <JobRow key={j.job_id} job={j} agents={state.agents} />)
        )}
      </Box>

      <Text bold underline>
        RECENT JOBS <Text dimColor>· {state.recentJobs.length}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {state.recentJobs.length === 0 ? (
          <Text dimColor>(none yet)</Text>
        ) : (
          state.recentJobs
            .slice(0, 25)
            .map((j) => <RecentJobRow key={j.job_id} job={j} agents={state.agents} />)
        )}
      </Box>
    </Box>
  );
}

function JobRow({
  job,
  agents,
}: {
  job: JobRecord;
  agents: AppState['agents'];
}): React.ReactElement {
  const agent = agents.find((a) => a.agent_id === job.agent_id);
  return (
    <Box>
      <Box width={28}>
        <Text dimColor>{job.job_id}</Text>
      </Box>
      <Box width={14}>
        <Text color={job.status === 'running' ? 'yellow' : 'cyan'}>{job.status}</Text>
      </Box>
      <Box width={16}><Text>{job.method}</Text></Box>
      <Box width={28}><Text>{job.repo}#{job.target_id}</Text></Box>
      <Text dimColor>{agent?.name ?? job.agent_id.slice(-8)}</Text>
    </Box>
  );
}

function RecentJobRow({
  job,
  agents,
}: {
  job: JobRecord;
  agents: AppState['agents'];
}): React.ReactElement {
  const agent = agents.find((a) => a.agent_id === job.agent_id);
  const outcomeColor =
    job.outcome === 'success'
      ? 'green'
      : job.outcome === 'task_error'
        ? 'yellow'
        : 'red';
  const completedAt = job.completed_at ?? job.dispatched_at;
  const ago = formatAgo(Date.now() - completedAt);
  return (
    <Box>
      <Box width={28}>
        <Text dimColor>{job.job_id}</Text>
      </Box>
      <Box width={14}>
        <Text color={outcomeColor}>{job.outcome ?? job.status}</Text>
      </Box>
      <Box width={16}><Text>{job.method}</Text></Box>
      <Box width={28}><Text>{job.repo}#{job.target_id}</Text></Box>
      <Box width={14}><Text dimColor>{agent?.name ?? job.agent_id.slice(-8)}</Text></Box>
      <Text dimColor>{ago}</Text>
    </Box>
  );
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}
