import React from 'react';
import { Box, Text } from 'ink';

interface Bind {
  key: string;
  label: string;
}

interface Props {
  binds: readonly Bind[];
}

export function KeybindBar({ binds }: Props): React.ReactElement {
  return (
    <Box paddingX={1}>
      {binds.map((b, i) => (
        <Text key={b.key}>
          {i > 0 ? '  ' : ''}
          <Text color="cyan">[{b.key}]</Text>
          <Text dimColor> {b.label}</Text>
        </Text>
      ))}
    </Box>
  );
}
