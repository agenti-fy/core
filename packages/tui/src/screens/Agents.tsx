import React from 'react';
import { Box, Text } from 'ink';
import {
  PERSONA_DEFAULTS,
  isBuiltinPersona,
  type AgentRecord,
} from '@agentify/shared';
import type { AppState } from '../store.js';

interface Props {
  state: AppState;
  selectedIndex: number;
}

export function Agents({ state, selectedIndex }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold underline>REGISTERED AGENTS</Text>
      <Box flexDirection="column" marginTop={1}>
        {state.agents.length === 0 ? (
          <Text dimColor>(none registered)</Text>
        ) : (
          state.agents.map((a, i) => (
            <Row key={a.agent_id} agent={a} selected={i === selectedIndex} />
          ))
        )}
      </Box>
      {state.agents[selectedIndex] && <Detail agent={state.agents[selectedIndex]} />}
    </Box>
  );
}

function Row({ agent, selected }: { agent: AgentRecord; selected: boolean }): React.ReactElement {
  const emoji = isBuiltinPersona(agent.type) ? PERSONA_DEFAULTS[agent.type].emoji : '✨';
  const status = agent.last_known_status ?? '—';
  const statusColor = status === 'IDLE' ? 'green' : status === 'BUSY' ? 'yellow' : status === 'FAILURE' ? 'red' : 'gray';
  return (
    <Box>
      <Box width={2}>
        {selected ? <Text color="cyan">›</Text> : <Text> </Text>}
      </Box>
      <Box width={3}>
        <Text>{emoji}</Text>
      </Box>
      <Box width={14}><Text>{agent.type}</Text></Box>
      <Box width={22}><Text dimColor>{agent.name}</Text></Box>
      <Box width={10}><Text color={statusColor} bold>{status}</Text></Box>
      <Text dimColor>{agent.url}</Text>
    </Box>
  );
}

function Detail({ agent }: { agent: AgentRecord }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold>{agent.name}</Text>
      <Text dimColor>id: {agent.agent_id}</Text>
      <Text dimColor>version: {agent.version}</Text>
      <Text dimColor>methods: {agent.supported_methods.join(', ')}</Text>
      <Text dimColor>registered: {new Date(agent.registered_at).toISOString()}</Text>
      <Text dimColor>
        last heartbeat:{' '}
        {agent.last_heartbeat ? `${Math.floor((Date.now() - agent.last_heartbeat) / 1000)}s ago` : 'never'}
      </Text>
    </Box>
  );
}
