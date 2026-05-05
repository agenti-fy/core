import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../store.js';
import type { RepoRecord } from '@agentify/shared';

export function Repos({ state }: { state: AppState }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold underline>MANAGED REPOS</Text>
      <Box flexDirection="column" marginTop={1}>
        {state.repos.length === 0 ? (
          <Text dimColor>(none discovered)</Text>
        ) : (
          state.repos.map((r) => <Row key={r.repo} repo={r} />)
        )}
      </Box>
    </Box>
  );
}

function Row({ repo }: { repo: RepoRecord }): React.ReactElement {
  return (
    <Box>
      <Box width={40}><Text>{repo.repo}</Text></Box>
      <Box width={10}>
        <Text color={repo.active ? 'green' : 'gray'}>
          {repo.active ? 'active' : 'paused'}
        </Text>
      </Box>
      <Box width={14}><Text dimColor>{repo.poll_interval_s}s</Text></Box>
      <Text dimColor>
        last polled: {repo.last_polled ? `${Math.floor((Date.now() - repo.last_polled) / 1000)}s ago` : 'never'}
      </Text>
    </Box>
  );
}
