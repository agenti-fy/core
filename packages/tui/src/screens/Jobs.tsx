import React from 'react';
import { Box, Text } from 'ink';
import { JobResultSchema, type JobRecord, type JobResult } from '@agentify/shared';
import type { AppState } from '../store.js';

const intlFmt = new Intl.NumberFormat('en-US');

function formatTokens(n: number | undefined): string {
  return n !== undefined ? intlFmt.format(n) : '—';
}

function formatCost(n: number | undefined): string {
  return n !== undefined ? `$${n.toFixed(4)}` : '—';
}

function parseResult(resultJson: string | null): JobResult | undefined {
  if (!resultJson) return undefined;
  try {
    return JobResultSchema.parse(JSON.parse(resultJson));
  } catch {
    return undefined;
  }
}

export function Jobs({ state, selectedIndex }: { state: AppState; selectedIndex: number }): React.ReactElement {
  const recentSlice = state.recentJobs.slice(0, 25);
  const selectedJob = recentSlice[selectedIndex];
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
        {recentSlice.length === 0 ? (
          <Text dimColor>(none yet)</Text>
        ) : (
          recentSlice.map((j, i) => (
            <RecentJobRow
              key={j.job_id}
              job={j}
              agents={state.agents}
              selected={i === selectedIndex}
            />
          ))
        )}
      </Box>
      {selectedJob && <JobDetail job={selectedJob} />}
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
  selected,
}: {
  job: JobRecord;
  agents: AppState['agents'];
  selected: boolean;
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
  const result = parseResult(job.result_json);
  const cost = result?.cost_usd;
  const costStr = formatCost(cost);
  const costZero = cost === undefined || cost === 0;
  return (
    <Box>
      <Box width={2}>
        {selected ? <Text color="cyan">›</Text> : <Text> </Text>}
      </Box>
      <Box width={28}>
        <Text dimColor>{job.job_id}</Text>
      </Box>
      <Box width={14}>
        <Text color={outcomeColor}>{job.outcome ?? job.status}</Text>
      </Box>
      <Box width={16}><Text>{job.method}</Text></Box>
      <Box width={28}><Text>{job.repo}#{job.target_id}</Text></Box>
      <Box width={14}><Text dimColor>{agent?.name ?? job.agent_id.slice(-8)}</Text></Box>
      <Box width={10} justifyContent="flex-end">
        <Text dimColor={costZero}>{costStr}</Text>
      </Box>
      <Text dimColor>  {ago}</Text>
    </Box>
  );
}

function JobDetail({ job }: { job: JobRecord }): React.ReactElement | null {
  const result = parseResult(job.result_json);
  if (!result) return null;
  const { usage_input, usage_output, usage_cache_read, usage_cache_write, cost_usd } = result;
  const hasData =
    usage_input !== undefined ||
    usage_output !== undefined ||
    usage_cache_read !== undefined ||
    usage_cache_write !== undefined ||
    cost_usd !== undefined;
  if (!hasData) return null;
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      <Text bold>
        {job.method} · {job.repo}#{job.target_id}
      </Text>
      <Box marginTop={1}>
        <Box flexDirection="column" marginRight={4}>
          <Text dimColor>input</Text>
          <Text>{formatTokens(usage_input)}</Text>
        </Box>
        <Box flexDirection="column" marginRight={4}>
          <Text dimColor>output</Text>
          <Text>{formatTokens(usage_output)}</Text>
        </Box>
        <Box flexDirection="column" marginRight={4}>
          <Text dimColor>cache read</Text>
          <Text>{formatTokens(usage_cache_read)}</Text>
        </Box>
        <Box flexDirection="column" marginRight={4}>
          <Text dimColor>cache write</Text>
          <Text>{formatTokens(usage_cache_write)}</Text>
        </Box>
        <Box flexDirection="column">
          <Text dimColor>cost</Text>
          <Text color={cost_usd !== undefined && cost_usd > 0 ? 'green' : undefined}>
            {formatCost(cost_usd)}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

function formatAgo(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}
