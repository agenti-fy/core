import type { JobArtifacts, JobOutcome, Method } from '@agentify/shared';

export interface SkillRunOptions {
  method: Method;
  repo: string;
  target_id: number;
  /**
   * Persona prose (who the agent is). Passed to the Agent SDK as
   * `systemPrompt`. Persona stays stable across the session; skill changes
   * per call.
   */
  personaBody: string;
  /**
   * Per-method instructions with template tokens filled in (what to do
   * right now). Passed as the user message.
   */
  skillPrompt: string;
  /**
   * Convenience: persona + skill concatenated, for adapters that don't
   * separate roles (e.g. the stub).
   */
  systemPrompt: string;
  /** Model identifier (SOUL frontmatter), or undefined to use SDK default. */
  model: string | undefined;
  /** Existing session id from the coordinator; null = start fresh. */
  sessionId: string | null;
  /** Per-job worktree path the SDK should treat as cwd. */
  cwd: string;
}

export interface SkillRunOutput {
  outcome: JobOutcome;
  /** New or reused session id. Null when the run failed before any session was established. */
  sessionId: string | null;
  artifacts: JobArtifacts;
  /** Free-form text response (model's final message). Stored for debugging. */
  finalText?: string;
  error?: { message: string; stack?: string };
  /**
   * SDK-reported usage (Anthropic field shape: input_tokens, output_tokens,
   * cache_read_input_tokens, cache_creation_input_tokens). The runner forwards
   * this to AgentMetrics; the stub adapter omits it.
   */
  usage?: Record<string, unknown>;
  /** SDK-reported total cost USD for this run (when the SDK exposes it). */
  costUsd?: number;
}

/**
 * The Claude execution surface, abstracted so we can swap in the real SDK
 * without changing callers. `StubClaudeAdapter` implements this with mock
 * responses; the production adapter wraps `@anthropic-ai/claude-code`.
 */
export interface ClaudeAdapter {
  run(opts: SkillRunOptions): Promise<SkillRunOutput>;
}
