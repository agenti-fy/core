import React from 'react';
import { Box, Text } from 'ink';

interface Props {
  willHalt: boolean;
}

export function HaltModal({ willHalt }: Props): React.ReactElement {
  return (
    <Box
      borderStyle="double"
      borderColor={willHalt ? 'red' : 'green'}
      paddingX={2}
      paddingY={1}
      flexDirection="column"
    >
      <Text bold>
        {willHalt ? 'Halt all dispatch?' : 'Resume dispatch?'}
      </Text>
      <Text dimColor>
        {willHalt
          ? 'In-flight jobs continue; no new ones will be dispatched.'
          : 'New jobs will be dispatched as the work poller finds them.'}
      </Text>
      <Text>
        <Text color="green" bold>[y]</Text> confirm   <Text color="red" bold>[n]</Text> cancel
      </Text>
    </Box>
  );
}
