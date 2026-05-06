import React, { useEffect, useMemo, useRef } from 'react';
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

type CacheEntry = { completed_at: number | null; parsed: JobResult | undefined };
export type ParsedCache = Map<string, CacheEntry>;

/**
 * Builds a ParsedCache for `jobs`, reusing entries from `prevCache` when
 * `(job_id, completed_at)` is unchanged so `JobResultSchema.parse` is called
 * at most once per completed job. Keys for jobs no longer in the slice are
 * dropped, keeping the cache bounded.
 */
export function buildParsedResultCache(jobs: JobRecord[], prevCache: ParsedCache): ParsedCache {
  const next: ParsedCache = new Map();
  for (const job of jobs) {
    const completedAt = job.completed_at ?? null;
    const prev = prevCache.get(job.job_id);
    if (prev !== undefined && prev.completed_at === completedAt) {
      next.set(job.job_id, prev);
    } else {
      next.set(job.job_id, { completed_at: completedAt, parsed: parseResult(job.result_json) });
    }
  }
  return next;
}

export function Jobs({ state, selectedIndex }: { state: AppState; selectedIndex: number }): React.ReactElement {
  const recentSlice = state.recentJobs.slice(0, 25);
  // useMemo + post-commit ref (not ref mutation during render): keeps prev-snapshot stable under Strict Mode / concurrent re-renders so cache reuse stays correct (see #179).
  const prevCacheRef = useRef<ParsedCache>(new Map());
  const parsedMap = useMemo(
    () => buildParsedResultCache(recentSlice, prevCacheRef.current),
    [recentSlice],
  );
  useEffect(() => {
    prevCacheRef.current = parsedMap;
  });

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
              parsed={parsedMap.get(j.job_id)?.parsed}
            />
          ))
        )}
      </Box>
      {selectedJob && (
        <JobDetail job={selectedJob} parsed={parsedMap.get(selectedJob.job_id)?.parsed} />
      )}
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
  parsed,
}: {
  job: JobRecord;
  agents: AppState['agents'];
  selected: boolean;
  parsed: JobResult | undefined;
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
  const cost = parsed?.cost_usd;
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

function JobDetail({
  job,
  parsed,
}: {
  job: JobRecord;
  parsed: JobResult | undefined;
}): React.ReactElement | null {
  if (!parsed) return null;
  const { usage_input, usage_output, usage_cache_read, usage_cache_write, cost_usd } = parsed;
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
