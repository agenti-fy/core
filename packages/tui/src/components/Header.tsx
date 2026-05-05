import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../store.js';

interface Props {
  state: AppState;
  baseUrl: string;
}

export function Header({ state, baseUrl }: Props): React.ReactElement {
  const counts = countByStatus(state.agents);
  const open = state.jobs.length;
  const repos = state.repos.length;
  const ts = new Date().toISOString().split('T')[1]?.slice(0, 8) ?? '';

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text color="cyan" bold>agentify</Text>
          <Text dimColor> · </Text>
          <Text>{baseUrl}</Text>
          <Text dimColor> · </Text>
          <Text>{ts}</Text>
        </Text>
        <Text>
          {state.halted ? (
            <Text bold color="black" backgroundColor="red"> HALT </Text>
          ) : (
            <Text dimColor>halt: off</Text>
          )}
        </Text>
      </Box>
      <Box gap={3}>
        <Text>
          <Text color="green">IDLE</Text> {counts.IDLE}
        </Text>
        <Text>
          <Text color="yellow">BUSY</Text> {counts.BUSY}
        </Text>
        <Text>
          <Text color="red">FAILURE</Text> {counts.FAILURE}
        </Text>
        <Text dimColor>·</Text>
        <Text>
          <Text bold>OPEN JOBS</Text> {open}
        </Text>
        <Text>
          <Text bold>REPOS</Text> {repos}
        </Text>
      </Box>
      {state.lastError && (
        <Text color="red">⚠ {state.lastError}</Text>
      )}
    </Box>
  );
}

function countByStatus(agents: AppState['agents']): Record<'IDLE' | 'BUSY' | 'FAILURE', number> {
  const out = { IDLE: 0, BUSY: 0, FAILURE: 0 };
  for (const a of agents) {
    if (a.last_known_status && a.last_known_status in out) {
      out[a.last_known_status]++;
    }
  }
  return out;
}
