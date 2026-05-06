import React, { useEffect, useReducer, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import { Header } from './components/Header.js';
import { KeybindBar } from './components/KeybindBar.js';
import { HaltModal } from './components/HaltModal.js';
import { Toasts } from './components/Toasts.js';
import { Dashboard } from './screens/Dashboard.js';
import { Agents } from './screens/Agents.js';
import { Jobs } from './screens/Jobs.js';
import { Repos } from './screens/Repos.js';
import { Logs } from './screens/Logs.js';
import {
  initialState,
  logRing,
  makeToast,
  reducer,
  type AppState,
} from './store.js';
import { consumeLogs } from './logs.js';
import type { CoordinatorApi } from './api.js';

type Screen = 'dashboard' | 'agents' | 'jobs' | 'repos' | 'logs';

interface Props {
  api: CoordinatorApi;
  baseUrl: string;
  pollIntervalMs?: number;
}

const LOGS_VISIBLE_ROWS = 20;

export function App({ api, baseUrl, pollIntervalMs = 1000 }: Props): React.ReactElement {
  const { isRawModeSupported } = useStdin();
  const [state, dispatch] = useReducer(reducer, initialState);
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [agentsCursor, setAgentsCursor] = useState(0);
  const [jobsCursor, setJobsCursor] = useState(0);
  const [haltConfirm, setHaltConfirm] = useState(false);

  // Polling loop: each endpoint resolves independently so a single 500 doesn't
  // nuke the whole dashboard.
  useEffect(() => {
    let stopped = false;
    const tick = async (): Promise<void> => {
      // Early bail before issuing 5 HTTP requests — without this, a
      // setTimeout-scheduled tick that fires AFTER the cleanup runs sends
      // round-trips that the dispatch will ignore.
      if (stopped) return;
      const [agentsR, jobsR, recentR, reposR, haltedR] = await Promise.allSettled([
        api.listAgents(),
        api.listJobs({ status: 'open' }),
        api.listJobs({ status: 'recent', limit: 50 }),
        api.listRepos(),
        api.getHalt(),
      ]);
      if (stopped) return;

      const partial: Partial<Pick<AppState, 'agents' | 'jobs' | 'recentJobs' | 'repos' | 'halted'>> = {};
      const errors: string[] = [];
      const note = (label: string, r: PromiseSettledResult<unknown>): void => {
        if (r.status === 'rejected') {
          errors.push(`${label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
        }
      };
      if (agentsR.status === 'fulfilled') partial.agents = agentsR.value;
      else note('agents', agentsR);
      if (jobsR.status === 'fulfilled') partial.jobs = jobsR.value;
      else note('jobs', jobsR);
      if (recentR.status === 'fulfilled') partial.recentJobs = recentR.value;
      else note('recent', recentR);
      if (reposR.status === 'fulfilled') partial.repos = reposR.value;
      else note('repos', reposR);
      if (haltedR.status === 'fulfilled') partial.halted = haltedR.value;
      else note('halt', haltedR);

      dispatch({
        type: 'fetch_partial',
        partial,
        ...(errors.length > 0 ? { error: errors.join(' · ') } : {}),
      });

      if (!stopped) {
        const t = setTimeout(() => void tick(), pollIntervalMs);
        t.unref();
      }
    };
    void tick();
    return () => {
      stopped = true;
    };
  }, [api, pollIntervalMs]);

  // SSE log consumer: writes into the mutable ring. We re-render via log_tick
  // throttled to ~10Hz, but skip the dispatch when nothing new arrived.
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      for await (const entry of consumeLogs(baseUrl, abort)) {
        logRing.push(entry);
      }
    })();
    const t = setInterval(() => dispatch({ type: 'log_tick' }), 100);
    t.unref();
    return () => {
      abort.abort();
      clearInterval(t);
    };
  }, [baseUrl]);

  // Toast expiry tick.
  useEffect(() => {
    const t = setInterval(() => dispatch({ type: 'toast_expire', now: Date.now() }), 500);
    t.unref();
    return () => clearInterval(t);
  }, []);

  // re-clamp on render: recentJobs can shrink between keypresses (jobs aging out)
  const jobsMax = Math.max(0, Math.min(state.recentJobs.length, 25) - 1);
  const safeJobsCursor = Math.min(jobsCursor, jobsMax);

  const agentsMax = Math.max(0, state.agents.length - 1);
  const safeAgentsCursor = Math.min(agentsCursor, agentsMax);

  const screenView =
    screen === 'dashboard' ? (
      <Dashboard state={state} />
    ) : screen === 'agents' ? (
      <Agents state={state} selectedIndex={safeAgentsCursor} />
    ) : screen === 'jobs' ? (
      <Jobs state={state} selectedIndex={safeJobsCursor} />
    ) : screen === 'logs' ? (
      <Logs state={state} rows={LOGS_VISIBLE_ROWS} />
    ) : (
      <Repos state={state} />
    );

  return (
    <Box flexDirection="column">
      <Header state={state} baseUrl={baseUrl} />
      {state.loading && state.lastFetchedAt === null ? (
        <Box paddingX={1} paddingY={1}>
          <Text dimColor>connecting…</Text>
        </Box>
      ) : (
        screenView
      )}
      {haltConfirm && <HaltModal willHalt={!state.halted} />}
      <Toasts toasts={state.toasts} />
      <KeybindBar
        binds={[
          { key: 'd', label: 'dashboard' },
          { key: 'a', label: 'agents' },
          { key: 'j', label: 'jobs' },
          { key: 'r', label: 'repos' },
          { key: 'l', label: 'logs' },
          { key: 'h', label: state.halted ? 'resume' : 'halt' },
          { key: 'q', label: 'quit' },
          ...(screen === 'agents' ? [{ key: 'R', label: 'reset agent' }] : []),
          ...(screen === 'jobs' ? [{ key: '↑↓', label: 'select job' }] : []),
          ...(screen === 'logs'
            ? [
                { key: '1-5', label: 'log level' },
                { key: 'PgUp/PgDn', label: 'scroll' },
                { key: 'g/G', label: 'live' },
              ]
            : []),
        ]}
      />
      {!isRawModeSupported && (
        <Box paddingX={1}>
          <Text dimColor>(non-interactive: keyboard disabled — Ctrl-C to exit)</Text>
        </Box>
      )}
      {isRawModeSupported && (
        <InputHandler
          api={api}
          state={state}
          screen={screen}
          setScreen={setScreen}
          agentsCursor={safeAgentsCursor}
          setAgentsCursor={setAgentsCursor}
          jobsCursor={safeJobsCursor}
          setJobsCursor={setJobsCursor}
          haltConfirm={haltConfirm}
          setHaltConfirm={setHaltConfirm}
          dispatch={dispatch}
        />
      )}
    </Box>
  );
}

interface InputHandlerProps {
  api: CoordinatorApi;
  state: AppState;
  screen: Screen;
  setScreen: (s: Screen) => void;
  agentsCursor: number;
  setAgentsCursor: React.Dispatch<React.SetStateAction<number>>;
  jobsCursor: number;
  setJobsCursor: React.Dispatch<React.SetStateAction<number>>;
  haltConfirm: boolean;
  setHaltConfirm: (v: boolean) => void;
  dispatch: React.Dispatch<Parameters<typeof reducer>[1]>;
}

function InputHandler({
  api,
  state,
  screen,
  setScreen,
  agentsCursor,
  setAgentsCursor,
  jobsCursor,
  setJobsCursor,
  haltConfirm,
  setHaltConfirm,
  dispatch,
}: InputHandlerProps): null {
  const { exit } = useApp();
  useInput((input, key) => {
    if (haltConfirm) {
      if (input === 'y') {
        const next = !state.halted;
        void api
          .setHalt(next)
          .then(() =>
            dispatch({
              type: 'toast_push',
              toast: makeToast('info', next ? 'halted' : 'resumed'),
            }),
          )
          .catch((err) =>
            dispatch({
              type: 'toast_push',
              toast: makeToast('error', `halt failed: ${err instanceof Error ? err.message : String(err)}`),
            }),
          );
        setHaltConfirm(false);
      } else if (input === 'n' || key.escape) {
        setHaltConfirm(false);
      }
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (input === 'd') setScreen('dashboard');
    if (input === 'a') setScreen('agents');
    if (input === 'j') setScreen('jobs');
    if (input === 'r') setScreen('repos');
    if (input === 'l') setScreen('logs');
    if (input === 'h') setHaltConfirm(true);

    if (screen === 'agents' && state.agents.length > 0) {
      const max = state.agents.length - 1;
      if (key.upArrow) setAgentsCursor(Math.max(0, Math.min(max, agentsCursor - 1)));
      if (key.downArrow) setAgentsCursor(Math.max(0, Math.min(max, agentsCursor + 1)));
      if (input === 'R' && state.agents[agentsCursor]) {
        const id = state.agents[agentsCursor].agent_id;
        const name = state.agents[agentsCursor].name;
        void api
          .resetAgent(id)
          .then(() =>
            dispatch({ type: 'toast_push', toast: makeToast('info', `reset ${name}`) }),
          )
          .catch((err) =>
            dispatch({
              type: 'toast_push',
              toast: makeToast(
                'error',
                `reset ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
            }),
          );
      }
    }
    if (screen === 'jobs' && state.recentJobs.length > 0) {
      const max = Math.min(state.recentJobs.length, 25) - 1;
      if (key.upArrow) setJobsCursor(Math.max(0, Math.min(max, jobsCursor - 1)));
      if (key.downArrow) setJobsCursor(Math.max(0, Math.min(max, jobsCursor + 1)));
    }
    if (screen === 'logs') {
      if (input === '1') dispatch({ type: 'log_set_min_level', level: 10 });
      if (input === '2') dispatch({ type: 'log_set_min_level', level: 20 });
      if (input === '3') dispatch({ type: 'log_set_min_level', level: 30 });
      if (input === '4') dispatch({ type: 'log_set_min_level', level: 40 });
      if (input === '5') dispatch({ type: 'log_set_min_level', level: 50 });
      if (key.pageUp) dispatch({ type: 'log_scroll_by', delta: LOGS_VISIBLE_ROWS });
      if (key.pageDown) dispatch({ type: 'log_scroll_by', delta: -LOGS_VISIBLE_ROWS });
      if (input === 'G' || input === 'g') dispatch({ type: 'log_scroll_reset' });
    }
  });
  return null;
}
