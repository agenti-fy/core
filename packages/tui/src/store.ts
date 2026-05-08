import type { AgentRecord, JobRecord, RepoRecord } from '@agenti-fy/shared';
import type { LogEntry } from './logs.js';

const LOG_BUFFER_CAPACITY = 500;

/**
 * Mutable circular log buffer that we keep OUT of React state. The Logs
 * screen reads from a frozen snapshot taken once per render — appending a
 * new log line doesn't trigger a re-render of the world; only an explicit
 * `log_tick` action does, throttled to ~10Hz.
 */
class LogRing {
  private buf: (LogEntry | undefined)[] = new Array<LogEntry | undefined>(LOG_BUFFER_CAPACITY);
  private head = 0;
  private size = 0;
  private revision = 0;

  push(entry: LogEntry): void {
    this.buf[this.head] = entry;
    this.head = (this.head + 1) % LOG_BUFFER_CAPACITY;
    if (this.size < LOG_BUFFER_CAPACITY) this.size++;
    this.revision++;
  }

  /** Total pushes since process start (used to skip pointless re-renders). */
  rev(): number {
    return this.revision;
  }

  snapshot(): LogEntry[] {
    const out: LogEntry[] = new Array(this.size);
    const start = (this.head - this.size + LOG_BUFFER_CAPACITY) % LOG_BUFFER_CAPACITY;
    for (let i = 0; i < this.size; i++) out[i] = this.buf[(start + i) % LOG_BUFFER_CAPACITY]!;
    return out;
  }
}

export const logRing = new LogRing();

export type ToastKind = 'info' | 'error';
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  expires_at: number;
}

export interface AppState {
  agents: AgentRecord[];
  jobs: JobRecord[];
  recentJobs: JobRecord[];
  repos: RepoRecord[];
  halted: boolean;
  loading: boolean;
  lastError: string | null;
  lastFetchedAt: number | null;
  /** Snapshot of logRing taken on the most recent log_tick. */
  logs: LogEntry[];
  /** Highest minimum level the user wants to see. */
  logMinLevel: number;
  /** How many lines from the tail of `logs` to skip (scrollback). 0 = bottom. */
  logScrollOffset: number;
  /** Bumped each log_tick so React re-renders the Logs screen. */
  logRev: number;
  /** Transient toast notifications (UI feedback for user actions). */
  toasts: Toast[];
}

export const initialState: AppState = {
  agents: [],
  jobs: [],
  recentJobs: [],
  repos: [],
  halted: false,
  loading: true,
  lastError: null,
  lastFetchedAt: null,
  logs: [],
  logMinLevel: 30,
  logScrollOffset: 0,
  logRev: 0,
  toasts: [],
};

export type Action =
  | {
      type: 'fetch_partial';
      partial: Partial<Pick<AppState, 'agents' | 'jobs' | 'recentJobs' | 'repos' | 'halted'>>;
      error?: string;
    }
  | { type: 'log_tick' }
  | { type: 'log_set_min_level'; level: number }
  | { type: 'log_scroll_by'; delta: number }
  | { type: 'log_scroll_reset' }
  | { type: 'toast_push'; toast: Toast }
  | { type: 'toast_expire'; now: number };

let nextToastId = 1;
export function makeToast(kind: ToastKind, message: string, durationMs = 4000): Toast {
  return { id: nextToastId++, kind, message, expires_at: Date.now() + durationMs };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'fetch_partial':
      return {
        ...state,
        ...action.partial,
        loading: false,
        lastError: action.error ?? null,
        lastFetchedAt: Date.now(),
      };
    case 'log_tick': {
      // Skip the re-render entirely if no new log entries arrived since last tick.
      if (logRing.rev() === state.logRev) return state;
      return { ...state, logs: logRing.snapshot(), logRev: logRing.rev() };
    }
    case 'log_set_min_level':
      return { ...state, logMinLevel: action.level, logScrollOffset: 0 };
    case 'log_scroll_by':
      return {
        ...state,
        logScrollOffset: Math.max(0, state.logScrollOffset + action.delta),
      };
    case 'log_scroll_reset':
      return { ...state, logScrollOffset: 0 };
    case 'toast_push':
      return { ...state, toasts: [...state.toasts, action.toast] };
    case 'toast_expire': {
      const filtered = state.toasts.filter((t) => t.expires_at > action.now);
      if (filtered.length === state.toasts.length) return state;
      return { ...state, toasts: filtered };
    }
  }
}
