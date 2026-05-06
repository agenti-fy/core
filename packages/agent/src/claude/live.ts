import type { Logger } from 'pino';
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import {
  JobArtifactsSchema,
  type JobArtifacts,
  type JobOutcome,
  type Method,
} from '@agentify/shared';
import type {
  ClaudeAdapter,
  SkillRunOptions,
  SkillRunOutput,
} from './adapter.js';

export interface LiveClaudeAdapterOptions {
  logger: Logger;
  /**
   * Called inside `run()` to get the hard turn cap for the current method.
   * Reading at call time (not construction) means a POST /reset that mutates
   * the config object via applyHotReloadable() is picked up on the next call
   * without restarting the process.
   */
  maxTurnsForMethod: (method: Method) => number;
  /**
   * Called inside `run()` to get the wall-clock deadline for the current
   * invocation, in ms. Reading at call time (not construction) means a
   * POST /reset that mutates config.claudeTimeoutMs via applyHotReloadable()
   * is picked up on the next call without restarting the process. 0 disables.
   */
  timeoutMsGetter: () => number;
  /** Per-job cost ceiling in USD. 0 disables. */
  costLimitUsd: number;
  /** Permission mode for tool calls. Defaults to bypassPermissions for headless ops. */
  permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'default' | 'plan';
}

// Denied for every method: Task spawns a child agent (doubles token cost);
// WebFetch / WebSearch enable outbound network calls none of our skills need.
const ALWAYS_DENIED = ['Task', 'WebFetch', 'WebSearch'] as const;

// Bash commands allowed for plan / review. These methods only read code and
// post GitHub comments — they must not push commits or modify worktree files.
// git rev-parse is included because review.md uses it to verify HEAD SHA.
const PLAN_REVIEW_BASH_ALLOW = [
  'Bash(gh *)',            // gh issue/pr subcommands
  'Bash(git log*)',        // history inspection
  'Bash(git show*)',       // commit inspection
  'Bash(git diff*)',       // diff inspection
  'Bash(git rev-parse*)',  // HEAD SHA verification (review.md step 1)
  'Bash(ls*)',             // directory listing
  'Bash(cat*)',            // file reading + /tmp heredoc writes (plan.md step 5)
] as const;

/**
 * Per-method tool scoping. Every method denies `Task` / `WebFetch` / `WebSearch`
 * (the three amplifier tools defined in `ALWAYS_DENIED`). `plan` and `review`
 * additionally deny write tools (`Write` / `Edit` / `NotebookEdit`) and gate
 * `Bash` to a read-only allowlist (`PLAN_REVIEW_BASH_ALLOW`). `implement` /
 * `address_review` / `merge` keep full `Bash` and only deny the three amplifiers.
 * Defense-in-depth, not a sandbox — the model can still call APIs directly.
 */
const TOOLS_BY_METHOD: Record<Method, { allowed?: string[]; disallowed?: string[] }> = {
  plan: {
    allowed: [...PLAN_REVIEW_BASH_ALLOW],
    disallowed: [...ALWAYS_DENIED, 'Write', 'Edit', 'NotebookEdit'],
  },
  review: {
    allowed: [...PLAN_REVIEW_BASH_ALLOW],
    disallowed: [...ALWAYS_DENIED, 'Write', 'Edit', 'NotebookEdit'],
  },
  implement: {
    disallowed: [...ALWAYS_DENIED],
  },
  address_review: {
    disallowed: [...ALWAYS_DENIED],
  },
  merge: {
    disallowed: [...ALWAYS_DENIED],
  },
};

// Warn once per process when a job completes without cost data, indicating
// the SDK version doesn't report it (best-effort check, not a hard failure).
let warnedNoCostData = false;

/**
 * Production adapter wrapping the official Claude Agent SDK.
 */
export class LiveClaudeAdapter implements ClaudeAdapter {
  private readonly logger: Logger;
  private readonly maxTurnsForMethod: (method: Method) => number;
  private readonly timeoutMsGetter: () => number;
  private readonly costLimitUsd: number;
  private readonly permissionMode: NonNullable<LiveClaudeAdapterOptions['permissionMode']>;

  constructor(opts: LiveClaudeAdapterOptions) {
    this.logger = opts.logger;
    this.maxTurnsForMethod = opts.maxTurnsForMethod;
    this.timeoutMsGetter = opts.timeoutMsGetter;
    this.costLimitUsd = opts.costLimitUsd;
    this.permissionMode = opts.permissionMode ?? 'bypassPermissions';
  }

  /**
   * Assembles the options object passed to the Claude Agent SDK `query()` call.
   * Extracted as a static method so unit tests can verify tool scoping per method
   * without running a live SDK session.
   */
  static buildSdkOptions(
    opts: SkillRunOptions,
    context: { maxTurns: number; permissionMode: string; abortController: AbortController },
  ): Record<string, unknown> {
    const tools = TOOLS_BY_METHOD[opts.method];

    // Build the systemPrompt as a string[]. The stable section (persona body +
    // skill template with only the signature substituted) is byte-identical
    // across jobs for the same soul+method, so the Anthropic API can cache it.
    // SYSTEM_PROMPT_DYNAMIC_BOUNDARY marks where the non-cacheable volatile
    // block (task vars: repo, target_id, persona) begins. The dynamic trailer
    // is excluded from caching deliberately — caching it would burn a breakpoint
    // on a per-job value that changes on every call.
    const systemPrompt: string[] = opts.systemPrompt.volatile
      ? [opts.systemPrompt.stable, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, opts.systemPrompt.volatile]
      : [opts.systemPrompt.stable];

    const sdkOptions: Record<string, unknown> = {
      cwd: opts.cwd,
      systemPrompt,
      maxTurns: context.maxTurns,
      permissionMode: context.permissionMode,
      abortController: context.abortController,
    };
    if (opts.model) sdkOptions['model'] = opts.model;
    if (opts.sessionId) sdkOptions['resume'] = opts.sessionId;
    if (tools.allowed) sdkOptions['allowedTools'] = tools.allowed;
    if (tools.disallowed) sdkOptions['disallowedTools'] = tools.disallowed;
    return sdkOptions;
  }

  async run(opts: SkillRunOptions): Promise<SkillRunOutput> {
    const log = this.logger.child({
      method: opts.method,
      repo: opts.repo,
      target_id: opts.target_id,
      model: opts.model,
      session_resumed: opts.sessionId !== null,
    });
    const startedAt = Date.now();
    log.info('claude-sdk: starting skill');

    let sessionId: string | null = opts.sessionId;
    let finalText = '';
    let resultErrorSubtype: string | null = null;
    let resultText = '';
    let messageCount = 0;
    let assistantMessageCount = 0;
    let toolUseCount = 0;
    let usage: Record<string, unknown> | undefined;
    let costUsd: number | undefined;
    let seenCostData = false;
    let abortedForCostLimit = false;

    const ac = new AbortController();
    // ac.signal.aborted is the only signal we read in the catch — no need to
    // pass a reason that nobody inspects.
    const timeoutMs = this.timeoutMsGetter();
    const timer =
      timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : null;
    timer?.unref();

    // Periodic heartbeat so operators watching /logs/stream see progress on
    // long-running models. Cleared in the finally block.
    const progressTimer = setInterval(() => {
      log.info(
        {
          messageCount,
          assistantMessageCount,
          toolUseCount,
          elapsed_s: Math.floor((Date.now() - startedAt) / 1000),
        },
        'claude-sdk: progress',
      );
    }, 30_000);
    progressTimer.unref();

    try {
      const sdkOptions = LiveClaudeAdapter.buildSdkOptions(opts, {
        maxTurns: this.maxTurnsForMethod(opts.method),
        permissionMode: this.permissionMode,
        abortController: ac,
      });

      const stream = query({
        prompt: opts.skillPrompt,
        options: sdkOptions,
      });

      for await (const message of stream as AsyncIterable<SdkMessage>) {
        messageCount++;
        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = (message as SdkSystemInit).session_id ?? sessionId;
          log.debug({ session_id: sessionId }, 'claude-sdk: session init');
          continue;
        }
        if (message.type === 'assistant') {
          assistantMessageCount++;
          const am = message as SdkAssistant;
          const text = extractText(am.message);
          if (text) finalText = text;
          // Count tool_use blocks for progress visibility.
          for (const block of am.message?.content ?? []) {
            if (block.type === 'tool_use') toolUseCount++;
          }
          log.debug(
            { assistantMessageCount, hasText: text.length > 0 },
            'claude-sdk: assistant message',
          );
          continue;
        }
        if (message.type === 'result') {
          const r = message as SdkResult;
          if (r.subtype && r.subtype.startsWith('error_')) {
            resultErrorSubtype = r.subtype;
          }
          if (typeof r.result === 'string') resultText = r.result;
          if (typeof r.session_id === 'string') sessionId = r.session_id;
          if (r.usage) usage = r.usage;
          if (typeof r.total_cost_usd === 'number') {
            costUsd = r.total_cost_usd;
            seenCostData = true;
            if (this.costLimitUsd > 0 && costUsd > this.costLimitUsd) {
              abortedForCostLimit = true;
              log.warn(
                {
                  costUsd,
                  limitUsd: this.costLimitUsd,
                  method: opts.method,
                  repo: opts.repo,
                  target_id: opts.target_id,
                },
                'claude-sdk: job cost limit exceeded, aborting',
              );
              ac.abort();
            }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;

      // Stale-session recovery. If the SDK rejected our `resume:` because the
      // local conversation store doesn't have that session (container
      // recreated, .claude/ wiped, etc.), retry once without `resume`. This
      // is bounded — the recursive call passes sessionId=null so the second
      // attempt can't match the same condition.
      if (opts.sessionId && isStaleSessionError(message)) {
        if (timer) clearTimeout(timer);
        clearInterval(progressTimer);
        log.warn(
          { stale: opts.sessionId, err: message },
          'claude-sdk: stale session, retrying without resume',
        );
        return this.run({ ...opts, sessionId: null });
      }

      // ac.signal.aborted is the source-of-truth for timeout/cost-limit: we
      // own the controller and only abort it from those two paths. Don't
      // depend on the SDK's wrapped error message.
      const isAborted = ac.signal.aborted;
      const outcome: Extract<JobOutcome, 'auth_failure' | 'sdk_failure' | 'task_error'> =
        isAborted
          ? 'task_error'
          : looksLikeAuthError(message)
            ? 'auth_failure'
            : 'sdk_failure';
      log.error(
        { err: message, outcome, abortedForCostLimit, isTimeout: isAborted && !abortedForCostLimit },
        'claude-sdk: stream threw',
      );
      const errorPayload = abortedForCostLimit
        ? {
            message: `cost limit exceeded: $${costUsd?.toFixed(4)} USD exceeds ceiling $${this.costLimitUsd} USD`,
          }
        : stack
          ? { message, stack }
          : { message };
      return {
        outcome,
        sessionId: outcome === 'auth_failure' ? null : sessionId,
        artifacts: {},
        finalText,
        error: errorPayload,
        // Forward whatever usage/cost we captured before the failure — partial
        // numbers are still useful for budget tracking.
        ...(usage ? { usage } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
      clearInterval(progressTimer);
      if (this.costLimitUsd > 0 && !seenCostData && !warnedNoCostData) {
        warnedNoCostData = true;
        log.warn(
          'claude-sdk: SDK did not report cost data — cost ceiling check skipped (older SDK version?)',
        );
      }
    }

    if (resultErrorSubtype) {
      // Same stale-session recovery for the result-message path: some SDK
      // versions surface stale-session as a result.subtype=error_* with the
      // diagnostic in r.result instead of throwing.
      if (opts.sessionId && isStaleSessionError(resultText)) {
        log.warn(
          { stale: opts.sessionId, subtype: resultErrorSubtype, err: resultText },
          'claude-sdk: stale session in result, retrying without resume',
        );
        return this.run({ ...opts, sessionId: null });
      }

      log.warn({ subtype: resultErrorSubtype }, 'claude-sdk: result error subtype');
      return {
        outcome: 'task_error',
        sessionId,
        artifacts: {},
        finalText,
        error: { message: `claude result error: ${resultErrorSubtype}` },
        ...(usage ? { usage } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    }

    const artifacts = extractArtifacts(opts.method, finalText, log);
    log.info(
      {
        messageCount,
        assistantMessageCount,
        toolUseCount,
        finalChars: finalText.length,
        artifactKeys: Object.keys(artifacts),
        costUsd,
        usage,
        duration_s: Math.floor((Date.now() - startedAt) / 1000),
      },
      'claude-sdk: complete',
    );
    return {
      outcome: 'success',
      sessionId,
      artifacts,
      finalText,
      ...(usage ? { usage } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  }
}

/**
 * Parse the model's final assistant text into a `JobArtifacts` for the given
 * method. Every skill prompt instructs the model to return a JSON object
 * matching its slot in `JobArtifactsSchema` (e.g. plan → `{ "child_issues":
 * [...] }`). If we don't extract that, downstream consumers — most notably
 * the plan-completion-poller, which only sees plans that the job-poller
 * upserts when `artifacts.plan.child_issues` is non-empty — silently no-op.
 *
 * Robust to the model wrapping the JSON in fenced code blocks or in a longer
 * trailing summary. Strategy:
 *  1. Try to parse the entire trimmed text as JSON.
 *  2. Else scan for fenced ```json (or unlabelled) blocks, last-wins.
 *  3. Else scan for a balanced trailing `{ ... }` substring, last-wins.
 *  4. Validate the candidate against the per-method schema slot. If anything
 *     fails, return `{}` and log — never throw, never fail the job.
 */
function extractArtifacts(method: Method, finalText: string, log: Logger): JobArtifacts {
  const trimmed = finalText.trim();
  if (!trimmed) return {};

  for (const candidate of jsonCandidates(trimmed)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;

    // The model returns the slot's contents directly (e.g. `{ "child_issues":
    // [...] }`), not the wrapped form (`{ "plan": { "child_issues": [...] } }`).
    // Wrap before validating.
    const wrapped = { [methodToArtifactKey(method)]: parsed };
    const result = JobArtifactsSchema.safeParse(wrapped);
    if (result.success) return result.data;
  }

  log.warn(
    { method, finalChars: finalText.length },
    'claude-sdk: could not parse artifacts from final text — downstream tracking (e.g. plan auto-close) will skip this job',
  );
  return {};
}

/**
 * Yield JSON candidates from `text` in priority order: whole-text first, then
 * fenced blocks (last-emitted-wins per skill convention), then balanced
 * trailing `{...}` substrings. Caller stops at the first one that parses AND
 * passes the schema.
 */
function* jsonCandidates(text: string): Generator<string> {
  // 1. Whole text (most common when the skill's last message is just the JSON).
  yield text;

  // 2. Fenced code blocks. Match ```json ... ``` and bare ``` ... ```. Iterate
  //    in REVERSE so the last block (the model's "final answer") wins.
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  const fences: string[] = [];
  for (let m = fenceRe.exec(text); m !== null; m = fenceRe.exec(text)) {
    if (m[1]) fences.push(m[1].trim());
  }
  for (let i = fences.length - 1; i >= 0; i--) {
    const f = fences[i];
    if (f) yield f;
  }

  // 3. Balanced trailing `{...}`. Walk from the LAST `}` back to find a
  //    balanced opening `{`. Cheap and avoids bringing in a JSON-finder dep.
  for (let end = text.lastIndexOf('}'); end !== -1; end = text.lastIndexOf('}', end - 1)) {
    let depth = 0;
    let start = -1;
    for (let i = end; i >= 0; i--) {
      const c = text[i];
      if (c === '}') depth++;
      else if (c === '{') {
        depth--;
        if (depth === 0) { start = i; break; }
      }
    }
    if (start >= 0) yield text.slice(start, end + 1);
  }
}

function methodToArtifactKey(method: Method): keyof JobArtifacts {
  switch (method) {
    case 'plan': return 'plan';
    case 'implement': return 'implement';
    case 'review': return 'review';
    case 'address_review': return 'address_review';
    case 'merge': return 'merge';
  }
}

// Visible for testing.
export const __test = {
  extractArtifacts,
  resetNoCostWarn() { warnedNoCostData = false; },
};

/* ============================================================== */
/*               Minimal structural types we rely on               */
/* ============================================================== */

type SdkMessage = { type: string; subtype?: string };

interface SdkSystemInit {
  type: 'system';
  subtype: 'init';
  session_id?: string;
}

interface SdkAssistant {
  type: 'assistant';
  message: { content?: Array<{ type: string; text?: string }> };
}

interface SdkResult {
  type: 'result';
  subtype?: string;
  /** Final text or error diagnostic depending on subtype. We read this to
   *  detect stale-session errors that arrive as result messages instead of
   *  thrown exceptions. */
  result?: string;
  session_id?: string;
  usage?: Record<string, unknown>;
  total_cost_usd?: number;
}

function extractText(msg: SdkAssistant['message']): string {
  if (!msg?.content) return '';
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

/**
 * The SDK signals an unresolvable resume by name in two known phrasings:
 *   "No conversation found with session ID: <uuid>"
 *   "session <uuid> not found"
 * Match both case-insensitively. We only act on this when opts.sessionId was
 * set — a fresh run can't be stale.
 */
function isStaleSessionError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('no conversation found with session id') ||
    /session\s+[0-9a-f-]{8,}.*not found/i.test(message)
  );
}

function looksLikeAuthError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('401') ||
    m.includes('403') ||
    m.includes('unauthorized') ||
    m.includes('forbidden') ||
    m.includes('invalid api key') ||
    m.includes('authentication')
  );
}
