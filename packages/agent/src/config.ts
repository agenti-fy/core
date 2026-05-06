import { z } from 'zod';
import { boolFlag, type Method } from '@agentify/shared';

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(8080),
  host: z.string().default('0.0.0.0'),
  soulPath: z.string().default('/etc/agentify/SOUL.md'),
  // Reject single quotes — the credential helper command interpolates this
  // path inside a shell-single-quoted string, and a quote in the path would
  // break the helper at runtime in confusing ways.
  workspacesDir: z
    .string()
    .refine((s) => !s.includes("'"), "WORKSPACES_DIR must not contain single quotes")
    .default('/workspaces'),
  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  coordinatorUrl: z.string().url(),
  agentPublicUrl: z.string().url(),

  registerRetryMs: z.coerce.number().int().positive().default(2000),
  registerMaxAttempts: z.coerce.number().int().positive().default(60),
  heartbeatIntervalMs: z.coerce.number().int().positive().default(15000),

  /** HTTP timeout for the agent's calls to the coordinator. */
  coordinatorTimeoutMs: z.coerce.number().int().positive().default(15000),

  /** Cap for the in-memory `AgentState.jobs` map (LRU). */
  jobHistoryCapacity: z.coerce.number().int().positive().default(500),

  /**
   * Global turn-cap fallback. Per-method vars (CLAUDE_MAX_TURNS_PLAN, etc.)
   * take precedence; this covers any method whose per-method var is unset.
   * Kept for one minor-version of backward compat before deprecation.
   */
  claudeMaxTurns: z.coerce.number().int().positive().default(500),

  /**
   * Per-method hard caps. Each env var overrides the global CLAUDE_MAX_TURNS
   * fallback for its method. Defaults are sized to real observed workloads:
   * merge is the tightest (≤50 turns normal), plan needs headroom for file
   * reads across a large repo.
   */
  claudeMaxTurnsPlan: z.coerce.number().int().positive().default(100),
  claudeMaxTurnsImplement: z.coerce.number().int().positive().default(250),
  claudeMaxTurnsReview: z.coerce.number().int().positive().default(60),
  claudeMaxTurnsAddressReview: z.coerce.number().int().positive().default(200),
  claudeMaxTurnsMerge: z.coerce.number().int().positive().default(50),

  /** SDK call timeout. 0 disables. */
  claudeTimeoutMs: z.coerce.number().int().nonnegative().default(15 * 60 * 1000),

  // Required when disableGithub=false; checked in the superRefine below so
  // the agent can boot offline (DISABLE_GITHUB=true) without dummy values.
  githubAppId: z.string().optional(),
  githubAppPrivateKey: z.string().optional(),
  githubAppInstallationId: z.string().optional(),
  githubUser: z.string().optional(),

  anthropicApiKey: z.string().min(1).optional(),

  /**
   * Long-lived OAuth token from `claude setup-token` on a Max-subscribed
   * host. Alternative to ANTHROPIC_API_KEY for headless fleets. The Agent
   * SDK picks it up from process.env directly; we only track it here so the
   * `auto` adapter selection knows to go Live when only this is set.
   */
  claudeCodeOAuthToken: z.string().min(1).optional(),

  /**
   * Disable real GitHub side effects (label flips, comments). The runner logs
   * what it would have done. Useful for tests and the StubClaudeAdapter path.
   */
  disableGithub: boolFlag(false),

  /**
   * Force the Claude adapter selection. `auto` picks Live when EITHER
   * ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is set, otherwise Stub.
   */
  claudeAdapter: z.enum(['auto', 'live', 'stub']).default('auto'),
}).superRefine((cfg, ctx) => {
  if (cfg.disableGithub) return;
  for (const key of [
    'githubAppId',
    'githubAppPrivateKey',
    'githubAppInstallationId',
    'githubUser',
  ] as const) {
    if (!cfg[key] || cfg[key].length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required unless DISABLE_GITHUB=true`,
      });
    }
  }
});

export type Config = z.infer<typeof ConfigSchema>;

/** Return the turn cap for `method`, honouring per-method overrides. */
export function resolveMaxTurns(config: Config, method: Method): number {
  switch (method) {
    case 'plan':           return config.claudeMaxTurnsPlan;
    case 'implement':      return config.claudeMaxTurnsImplement;
    case 'review':         return config.claudeMaxTurnsReview;
    case 'address_review': return config.claudeMaxTurnsAddressReview;
    case 'merge':          return config.claudeMaxTurnsMerge;
  }
}

/**
 * Copy hot-reloadable fields from `fresh` onto `config` in-place so that
 * closures already capturing `config` (e.g. `resolveMaxTurns` and the
 * `timeoutMsGetter` inside LiveClaudeAdapter) see new values on the next
 * call without a restart.
 *
 * Hot-reloadable: per-method turn budgets (claudeMaxTurns*) and claudeTimeoutMs.
 * Not hot-reloadable (restart required): host, port, coordinatorUrl,
 * agentPublicUrl, heartbeatIntervalMs, credentials.
 */
export function applyHotReloadable(config: Config, fresh: Config): void {
  config.claudeMaxTurns = fresh.claudeMaxTurns;
  config.claudeMaxTurnsPlan = fresh.claudeMaxTurnsPlan;
  config.claudeMaxTurnsImplement = fresh.claudeMaxTurnsImplement;
  config.claudeMaxTurnsReview = fresh.claudeMaxTurnsReview;
  config.claudeMaxTurnsAddressReview = fresh.claudeMaxTurnsAddressReview;
  config.claudeMaxTurnsMerge = fresh.claudeMaxTurnsMerge;
  config.claudeTimeoutMs = fresh.claudeTimeoutMs;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    port: env.AGENT_PORT ?? env.PORT,
    host: env.HOST,
    soulPath: env.SOUL_PATH,
    workspacesDir: env.WORKSPACES_DIR,
    logLevel: env.LOG_LEVEL,
    coordinatorUrl: env.COORDINATOR_URL,
    agentPublicUrl: env.AGENT_PUBLIC_URL,
    registerRetryMs: env.REGISTER_RETRY_MS,
    registerMaxAttempts: env.REGISTER_MAX_ATTEMPTS,
    heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
    coordinatorTimeoutMs: env.COORDINATOR_TIMEOUT_MS,
    jobHistoryCapacity: env.JOB_HISTORY_CAPACITY,
    claudeMaxTurns: env.CLAUDE_MAX_TURNS,
    // Per-method vars fall back to the global CLAUDE_MAX_TURNS when unset so
    // operators who only set the global don't need to touch per-method vars.
    claudeMaxTurnsPlan: env.CLAUDE_MAX_TURNS_PLAN ?? env.CLAUDE_MAX_TURNS,
    claudeMaxTurnsImplement: env.CLAUDE_MAX_TURNS_IMPLEMENT ?? env.CLAUDE_MAX_TURNS,
    claudeMaxTurnsReview: env.CLAUDE_MAX_TURNS_REVIEW ?? env.CLAUDE_MAX_TURNS,
    claudeMaxTurnsAddressReview: env.CLAUDE_MAX_TURNS_ADDRESS_REVIEW ?? env.CLAUDE_MAX_TURNS,
    claudeMaxTurnsMerge: env.CLAUDE_MAX_TURNS_MERGE ?? env.CLAUDE_MAX_TURNS,
    // compose's ${VAR-} expands to '' when VAR is unset; treat that as unset, not as 0=disabled
    claudeTimeoutMs: env.CLAUDE_TIMEOUT_MS || undefined,
    githubAppId: env.GITHUB_APP_ID,
    githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
    githubAppInstallationId: env.GITHUB_APP_INSTALLATION_ID,
    githubUser: env.GITHUB_USER,
    // Coerce empty string → undefined so that `${VAR-}` from compose (which
    // expands to "" when VAR is unset) doesn't trip the `.min(1)` schema.
    // .optional() in zod only excuses undefined, not "".
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    claudeCodeOAuthToken: env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
    disableGithub: env.DISABLE_GITHUB,
    claudeAdapter: env.CLAUDE_ADAPTER,
  });
}
