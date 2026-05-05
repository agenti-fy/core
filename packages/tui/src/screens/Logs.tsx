import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../store.js';
import type { LogEntry } from '../logs.js';

interface Props {
  state: AppState;
  rows: number;
}

const LEVEL_NAMES: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

const LEVEL_COLORS: Record<number, string> = {
  10: 'gray',
  20: 'blue',
  30: 'green',
  40: 'yellow',
  50: 'red',
  60: 'redBright',
};

export function Logs({ state, rows }: Props): React.ReactElement {
  const filtered = state.logs.filter((e) => e.level >= state.logMinLevel);
  const window = Math.max(5, rows);
  // Scroll: 0 = pinned to bottom (most recent). Larger = scroll back.
  const max = Math.max(0, filtered.length - window);
  const offset = Math.min(state.logScrollOffset, max);
  const end = filtered.length - offset;
  const start = Math.max(0, end - window);
  const visible = filtered.slice(start, end);
  const minLabel = LEVEL_NAMES[state.logMinLevel] ?? String(state.logMinLevel);
  const scrollIndicator =
    offset === 0
      ? '◀ live'
      : `↑${offset} (PgUp/PgDn, g=live)`;
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text>
        <Text bold underline>LOGS</Text>
        <Text dimColor>
          {' '}· min level <Text color="cyan">{minLabel}</Text> (1=trace 2=debug 3=info 4=warn
          5=error)
        </Text>
        <Text dimColor> · {filtered.length}/{state.logs.length} buffered</Text>
        <Text dimColor> · </Text>
        <Text color={offset === 0 ? 'green' : 'yellow'}>{scrollIndicator}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Text dimColor>(no logs at this level yet)</Text>
        ) : (
          visible.map((e, i) => <Row key={`${e.ts}-${start + i}`} entry={e} />)
        )}
      </Box>
    </Box>
  );
}

function Row({ entry }: { entry: LogEntry }): React.ReactElement {
  const level = entry.level;
  const levelLabel = LEVEL_NAMES[level] ?? String(level);
  const color = LEVEL_COLORS[level] ?? 'white';
  const time = entry.ts.split('T')[1]?.slice(0, 12) ?? entry.ts;
  const tag = entry.agent_id
    ? `agent:${entry.agent_id.slice(-6)}`
    : entry.service === 'coordinator'
      ? 'coord'
      : (entry.service ?? '');
  return (
    <Box>
      <Box width={14}><Text dimColor>{time}</Text></Box>
      <Box width={6}><Text color={color}>{levelLabel}</Text></Box>
      <Box width={14}><Text dimColor>{truncate(tag, 13)}</Text></Box>
      <Box flexGrow={1}>
        <Text>{truncate(entry.msg ?? '', 200)}</Text>
      </Box>
    </Box>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
