/**
 * anthropic.ts — Anthropic auth + tunables prompt driver.
 *
 * Guides the operator through choosing an Anthropic authentication path
 * (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN) and collecting three
 * tunables that have a real cost/correctness impact:
 *
 *   • LOG_LEVEL            — service log verbosity (default: "info")
 *   • WORK_POLL_S          — GitHub polling interval in seconds (default: 30)
 *   • CLAUDE_COST_LIMIT_USD — per-run cost ceiling in USD (default: 5.0)
 *
 * The auth path mirrors the comment block at docker-compose.yml:20-29:
 *   - ANTHROPIC_API_KEY     — classic sk-ant-* key; bills against API credits.
 *   - CLAUDE_CODE_OAUTH_TOKEN — long-lived (~1y) OAuth token from
 *     `claude setup-token`; preferred for headless fleets.
 *
 * Exported surface
 * ----------------
 * {@link runAnthropic}   – main entry; structurally satisfies PhaseFn from index.ts.
 * {@link AnthropicDeps} – dependency-injection bag (same shape as PhaseOpts).
 *
 * Note: this module does NOT import from index.ts — index.ts imports this
 * file, so any reverse import would create a circular dependency.  The
 * {@link AnthropicDeps} shape is structurally identical to PhaseOpts, so
 * TypeScript structural typing makes runAnthropic assignable to PhaseFn
 * without any cross-import.
 */

import {
  ask,
  askMasked,
  askChoice,
  printSection,
  printErr,
  type IoStreams,
} from '../prompts.js';
import type { WizardState } from '../state.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Dependency-injection bag for {@link runAnthropic}.
 *
 * Mirrors the PhaseOpts shape (`state` + `io`) without importing from index.ts.
 * TypeScript structural typing ensures runAnthropic is assignable to PhaseFn.
 */
export interface AnthropicDeps {
  /** Current wizard state at the start of this phase. */
  state: WizardState;
  /** Injectable I/O streams.  Defaults to process.stdin/stdout in production. */
  io: IoStreams;
}

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * Validate an ANTHROPIC_API_KEY value.
 * Returns a non-null error string when the key does not start with "sk-ant-".
 */
function validateApiKey(key: string): string | null {
  if (!key.startsWith('sk-ant-')) {
    return 'ANTHROPIC_API_KEY must start with "sk-ant-".';
  }
  return null;
}

/**
 * Validate a CLAUDE_CODE_OAUTH_TOKEN value.
 * Returns a non-null error string when the token is shorter than 20 characters.
 */
function validateOauthToken(token: string): string | null {
  if (token.length < 20) {
    return 'CLAUDE_CODE_OAUTH_TOKEN must be at least 20 characters.';
  }
  return null;
}

/**
 * Validate a WORK_POLL_S value.
 * Must be a decimal integer in the range 5-3600 (inclusive).
 */
function validateWorkPollS(s: string): string | null {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 5 || n > 3600) {
    return 'WORK_POLL_S must be an integer between 5 and 3600.';
  }
  return null;
}

/**
 * Validate a CLAUDE_COST_LIMIT_USD value.
 * Must parse as a positive finite number.
 */
function validateCostLimit(s: string): string | null {
  const n = Number(s);
  if (Number.isNaN(n) || n <= 0) {
    return 'CLAUDE_COST_LIMIT_USD must be a positive number.';
  }
  return null;
}

// ── Secret prompt with re-prompting ──────────────────────────────────────────

/**
 * Prompt for a masked secret, re-prompting until validation passes.
 *
 * `askMasked` provides no built-in validation, so this wrapper loops around
 * it until the user supplies a value that satisfies the `validate` function.
 *
 * @throws {PromptCancelled} When the user aborts (EOF / Ctrl-C).
 */
async function askSecretWithValidation(
  question: string,
  validate: (s: string) => string | null,
  io: IoStreams,
): Promise<string> {
  for (;;) {
    const secret = await askMasked(question, io);
    const err = validate(secret);
    if (err === null) return secret;
    printErr(err, io);
  }
}

// ── runAnthropic ──────────────────────────────────────────────────────────────

/**
 * Run the Anthropic authentication and tunables phase.
 *
 * Prompts (5 total — within the ≤5 budget from the issue spec):
 *
 *  1. **Auth path** (`askChoice`): ANTHROPIC_API_KEY (default) or
 *     CLAUDE_CODE_OAUTH_TOKEN. The menu shows the reasoning for each path,
 *     mirroring docker-compose.yml:20-29.
 *
 *  2. **Secret** (`askMasked`): the chosen key/token; masked as stars while
 *     typing.  Validation:
 *       - ANTHROPIC_API_KEY: must start with "sk-ant-"
 *       - CLAUDE_CODE_OAUTH_TOKEN: must be ≥ 20 chars
 *     Re-prompts on failure.
 *
 *  3. **LOG_LEVEL** (`askChoice`): info | debug | warn | error, default "info".
 *
 *  4. **WORK_POLL_S** (`ask`): integer, default 30, range 5-3600.
 *
 *  5. **CLAUDE_COST_LIMIT_USD** (`ask`): positive float, default 5.0.
 *
 * Returns a `Partial<WizardState>` containing `anthropic` and `tunables`.
 * Note: the caller (index.ts run()) holds the returned `anthropic` value in
 * memory so the finalize phase can render it to `.env`, but strips it before
 * every `saveFn` call — the secret is never written to disk (v1 policy from
 * #426/#430).  On `resume`, `state.anthropic` will be absent and the wizard
 * re-prompts for the secret, which is the correct behaviour per the spec.
 *
 * @throws {PromptCancelled} When the user presses Ctrl-C or sends EOF.
 */
export async function runAnthropic(deps: AnthropicDeps): Promise<Partial<WizardState>> {
  const { io } = deps;

  // ── Step 1: auth path ─────────────────────────────────────────────────────

  printSection('Anthropic authentication', io);

  const authKind = await askChoice<'api_key' | 'oauth_token'>(
    'Choose an auth path:',
    [
      {
        value: 'api_key',
        label:
          'ANTHROPIC_API_KEY — classic sk-ant-* API key; bills against API credits',
      },
      {
        value: 'oauth_token',
        label:
          'CLAUDE_CODE_OAUTH_TOKEN — long-lived (~1y) token from `claude setup-token`; preferred for headless fleets',
      },
    ],
    { default: 'api_key' },
    io,
  );

  // ── Step 2: secret ────────────────────────────────────────────────────────

  const secretQuestion =
    authKind === 'api_key'
      ? 'Paste your ANTHROPIC_API_KEY'
      : 'Paste your CLAUDE_CODE_OAUTH_TOKEN';

  const validate = authKind === 'api_key' ? validateApiKey : validateOauthToken;
  const secretValue = await askSecretWithValidation(secretQuestion, validate, io);

  const anthropic =
    authKind === 'api_key'
      ? ({ kind: 'api_key' as const, value: secretValue })
      : ({ kind: 'oauth_token' as const, value: secretValue });

  // ── Step 3: LOG_LEVEL ─────────────────────────────────────────────────────

  printSection('Tunables', io);

  const logLevel = await askChoice<'info' | 'debug' | 'warn' | 'error'>(
    'LOG_LEVEL (log verbosity):',
    [
      { value: 'info', label: 'info   — normal operational messages (recommended)' },
      { value: 'debug', label: 'debug  — verbose output for troubleshooting' },
      { value: 'warn', label: 'warn   — warnings and errors only' },
      { value: 'error', label: 'error  — errors only' },
    ],
    { default: 'info' },
    io,
  );

  // ── Step 4: WORK_POLL_S ───────────────────────────────────────────────────

  const workPollStr = await ask(
    'WORK_POLL_S (GitHub polling interval, integer seconds, 5-3600)',
    {
      default: '30',
      validate: validateWorkPollS,
    },
    io,
  );

  // ── Step 5: CLAUDE_COST_LIMIT_USD ─────────────────────────────────────────

  const costLimitStr = await ask(
    'CLAUDE_COST_LIMIT_USD (per-run cost ceiling in USD)',
    {
      default: '5.0',
      validate: validateCostLimit,
    },
    io,
  );

  // ── Build and return the partial state ────────────────────────────────────

  const tunables: Record<string, string | number> = {
    LOG_LEVEL: logLevel,
    WORK_POLL_S: Number(workPollStr),
    CLAUDE_COST_LIMIT_USD: parseFloat(costLimitStr),
  };

  return { anthropic, tunables };
}
