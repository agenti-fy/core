import React from 'react';
import { Box, Text } from 'ink';
import type { Toast } from '../store.js';

export function Toasts({ toasts }: { toasts: readonly Toast[] }): React.ReactElement | null {
  if (toasts.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1}>
      {toasts.slice(-3).map((t) => (
        <Text key={t.id}>
          <Text color={t.kind === 'error' ? 'red' : 'cyan'} bold>
            {t.kind === 'error' ? '⚠' : 'ℹ'}{' '}
          </Text>
          <Text>{t.message}</Text>
        </Text>
      ))}
    </Box>
  );
}
