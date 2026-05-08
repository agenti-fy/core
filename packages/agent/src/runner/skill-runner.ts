import type { Logger } from 'pino';
import {
  inProgressLabel,
  isBuiltinPersona,
  NEEDS_HUMAN_LABEL,
  PERSONA_DEFAULTS,
  routingLabel,
  type JobOutcome,
  type JobResult,
  type Method,
} from '@agenti-fy/shared';
import type { Config } from '../config.js';
import type { CoordinatorClient } from '../coordinator-client.js';
import type { AgentState } from '../state.js';
import type { ClaudeAdapter, SkillRunOutput } from '../claude/adapter.js';
import type { GitHubAdapter } from '../github/client.js';
import type { WorktreeManager } from '../git/worktree.js';
import type { WikiManager, PreparedWiki } from '../kb/wiki.js';
import { kbPersonaTitle } from '../kb/wiki.js';
import type { SoulRef } from '../soul/ref.js';
import type { AgentMetrics } from '../metrics.js';
import { modelForMethod, resolveSkill } from '../skills/resolver.js';

/**
 * Methods that form a productive thread — context from prior jobs genuinely
 * helps. review/merge read fresh state and decide; carrying stale context
 * from a previous PR review burns cache-read tokens without benefit.
 */
const SESSION_PERSISTENT_METHODS = new Set<Method>(['plan', 'implement', 'address_review']);

export interface RunSkillRequest {
  job_id: string;
  method: Method;
  repo: string;
  target_id: number;
  /**
   * Routing-label persona segment from the dispatch — see DispatchRequest.persona_name.
   * The agent uses THIS name when flipping its in-progress marker, NOT its
   * own frontmatter.name (which can differ for custom souls).
   */
  persona_name: string;
  /**
   * Coordinator-supplied session id at dispatch time. The runner uses this
   * directly instead of re-fetching via coordinator.getSession, saving an
   * HTTP roundtrip per dispatch. Null = start a fresh session.
   */
  session_id: string | null;
}

interface RunDeps {
  config: Config;
  soulRef: SoulRef;
  coordinator: CoordinatorClient;
  adapter: ClaudeAdapter;
  github: GitHubAdapter;
  worktreeManager: WorktreeManager;
  wikiManager: WikiManager;
  state: AgentState;
  logger: Logger;
  /** Optional in tests; production wires it from index.ts. */
  metrics?: AgentMetrics;
}

/**
 * Orchestrates a single skill execution end-to-end.
 */
export class SkillRunner {
  /**
   * Promise resolving when the current run() finishes. null when idle. Set in
   * enqueue() before the setImmediate fires; cleared when the inner run()
   * settles. Exposed via `inFlight()` so the agent's shutdown handler can
   * drain before closing the HTTP server.
   */
  private currentRun: Promise<void> | null = null;

  constructor(private readonly deps: RunDeps) {}

  /** Returns the current run's promise, or null if idle. */
  inFlight(): Promise<void> | null {
    return this.currentRun;
  }

  /** Fire-and-forget. Errors are caught here; they should never propagate. */
  enqueue(req: RunSkillRequest): void {
    // Capture the promise eagerly so an immediate `inFlight()` query sees the
    // run-in-progress; setImmediate would otherwise leave a tiny window where
    // currentRun is null between enqueue() and the next tick.
    let resolveDone: () => void;
    const done = new Promise<void>((r) => { resolveDone = r; });
    this.currentRun = done;
    setImmediate(() => {
      this.run(req)
        .catch(async (err) => {
          const message = err instanceof Error ? err.message : String(err);
          const log = this.deps.logger.child({
            job_id: req.job_id,
            method: req.method,
            repo: req.repo,
            target_id: req.target_id,
          });
          log.error(
            { err: message, stack: err instanceof Error ? err.stack : undefined },
            'skill runner: unhandled error',
          );
          // Best-effort cleanup so a thrown error from `run()` (which itself
          // catches everything — this path should be unreachable) doesn't leave
          // the issue stuck on `*-in-progress` and the metric un-recorded.
          // AWAIT both: previously these were fire-and-forget, which meant the
          // `done` promise resolved before the GitHub failure-comment finished
          // posting. A SIGTERM landing in that window would let the agent
          // shut down mid-comment, leaving the issue stuck on `*-in-progress`
          // until the stale-sweeper rescues it 30+ minutes later.
          try {
            await this.markNeedsHuman(req, headlineFor('sdk_failure', req.method), message, log);
          } catch {
            // markNeedsHuman is itself best-effort and shouldn't reject, but
            // belt-and-suspenders against a future change that might.
          }
          try {
            await this.cleanupWorktree(req, log);
          } catch {
            // same
          }
          try {
            this.deps.state.completeJob({
              job_id: req.job_id,
              method: req.method,
              repo: req.repo,
              target_id: req.target_id,
              outcome: 'sdk_failure',
              session_id: null,
              duration_ms: 0,
              artifacts: {},
              error: { message },
            });
            this.deps.metrics?.recordJob(req.method, 'sdk_failure', 0);
          } catch {
            // best-effort
          }
        })
        .finally(() => {
          // Clear inFlight only if no newer run replaced us. Without the
          // identity check, an enqueue+complete cycle that overlaps another
          // enqueue could clear the wrong promise.
          if (this.currentRun === done) this.currentRun = null;
          resolveDone();
        });
    });
  }

  private async run(req: RunSkillRequest): Promise<void> {
    const startedAt = Date.now();
    const log = this.deps.logger.child({
      job_id: req.job_id,
      method: req.method,
      repo: req.repo,
      target_id: req.target_id,
    });

    const agentId = this.deps.state.getAgentId();
    if (!agentId) {
      log.error('no agent_id at run-time — should be unreachable');
      this.completeWithFailure(req, startedAt, 'config_failure', 'agent not registered');
      return;
    }

    // The label flip and the worktree prepare are independent — fire them
    // concurrently. flipToInProgress is best-effort (its own try/catch),
    // so it returns void either way. prepare can throw and is the failure
    // we care about.
    //
    // Hold flip's promise OUTSIDE Promise.all so we can join it before any
    // markNeedsHuman call below. Otherwise, a prepare-fast-rejection causes
    // markNeedsHuman.replaceLabels to race the still-running flip's
    // replaceLabels, and the final label state depends on which call lands
    // last on GitHub.
    const flipPromise = this.flipToInProgress(req, log);
    let worktreePath: string;
    // Default to "KB unavailable"; overwritten after a successful wiki prepare.
    let wiki: PreparedWiki = { cloneDir: null, tokenFile: null };
    try {
      const wt = await this.deps.worktreeManager.prepare(req.repo, req.job_id);
      // After the code worktree is ready, run wiki prepare in parallel with the
      // label flip. Wiki prepare is best-effort: absorb any unexpected throw so
      // it never poisons the Promise.all and never blocks the run.
      const wikiPrepare = this.deps.wikiManager.prepare(req.repo, req.job_id).catch((err) => {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'wiki prepare threw unexpectedly — KB unavailable for this job',
        );
        return { cloneDir: null, tokenFile: null } satisfies PreparedWiki;
      });
      const [, prepared] = await Promise.all([flipPromise, wikiPrepare]);
      wiki = prepared;
      worktreePath = wt.path;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'worktree prepare failed');
      // Wait for the flip to settle before we touch labels again — flip is
      // best-effort and never rejects, so this can only resolve.
      await flipPromise.catch(() => undefined);
      // Don't revert to task:<method> — disk-full or auth-broken would loop
      // forever on the next dispatch. Mark needs-human and stop.
      await this.markNeedsHuman(req, headlineFor('config_failure', req.method), message, log);
      this.completeWithFailure(req, startedAt, 'config_failure', message);
      return;
    }

    // review and merge are stateless — don't resume a prior session even if
    // the coordinator supplied one. The agent decides here; live.ts receives null.
    const sessionId = SESSION_PERSISTENT_METHODS.has(req.method) ? req.session_id : null;
    const soul = this.deps.soulRef.current;
    const skill = resolveSkill({
      soul,
      method: req.method,
      repo: req.repo,
      target_id: req.target_id,
      personaName: req.persona_name,
      kbCloneDir: wiki.cloneDir,
      kbGlobalPage: this.deps.config.kbGlobalPage,
      // Persona page name is derived via kbPersonaTitle so casing rules live
      // in one place (wiki.ts) — e.g. tinkerer → KB-Tinkerer.
      kbPersonaPage: `${this.deps.config.kbPagePrefix}${kbPersonaTitle(soul)}`,
    });

    // Hand the model an authenticated `gh` and KB context for the duration of
    // this run. The credential helper inside the worktree authenticates git
    // operations, but `gh issue create` / `gh pr create` / `gh pr review` need
    // a token in env. We mint a fresh App installation token (1h-valid, cached)
    // and expose it as GH_TOKEN. Subprocess-inheritance covers the SDK's Bash
    // tool. The agent processes one job at a time, so mutating process.env
    // here is safe; we restore everything on the way out.
    const ghToken = await this.deps.worktreeManager.getInstallationToken().catch(() => null);
    const prevGhToken = process.env['GH_TOKEN'];
    const prevKbCloneDir = process.env['KB_CLONE_DIR'];
    const prevAgentifyPersona = process.env['AGENTIFY_PERSONA'];
    const prevAgentifyJobId = process.env['AGENTIFY_JOB_ID'];
    const prevAgentifyTargetId = process.env['AGENTIFY_TARGET_ID'];

    if (ghToken) process.env['GH_TOKEN'] = ghToken;
    // KB_CLONE_DIR is unset (not empty-string) when the wiki is unavailable.
    if (wiki.cloneDir !== null) {
      process.env['KB_CLONE_DIR'] = wiki.cloneDir;
    } else {
      delete process.env['KB_CLONE_DIR'];
    }
    process.env['AGENTIFY_PERSONA'] = req.persona_name;
    process.env['AGENTIFY_JOB_ID'] = req.job_id;
    process.env['AGENTIFY_TARGET_ID'] = String(req.target_id);

    /** Restore all env vars set above to their pre-run state. */
    const restoreEnv = (): void => {
      if (prevGhToken === undefined) delete process.env['GH_TOKEN'];
      else process.env['GH_TOKEN'] = prevGhToken;
      if (prevKbCloneDir === undefined) delete process.env['KB_CLONE_DIR'];
      else process.env['KB_CLONE_DIR'] = prevKbCloneDir;
      if (prevAgentifyPersona === undefined) delete process.env['AGENTIFY_PERSONA'];
      else process.env['AGENTIFY_PERSONA'] = prevAgentifyPersona;
      if (prevAgentifyJobId === undefined) delete process.env['AGENTIFY_JOB_ID'];
      else process.env['AGENTIFY_JOB_ID'] = prevAgentifyJobId;
      if (prevAgentifyTargetId === undefined) delete process.env['AGENTIFY_TARGET_ID'];
      else process.env['AGENTIFY_TARGET_ID'] = prevAgentifyTargetId;
    };

    let output;
    try {
      output = await this.deps.adapter.run({
        method: req.method,
        repo: req.repo,
        target_id: req.target_id,
        personaBody: skill.personaBody,
        skillPrompt: skill.skillPrompt,
        systemPrompt: skill.systemPrompt,
        model: modelForMethod(this.deps.soulRef.current, req.method),
        sessionId,
        cwd: worktreePath,
      });
    } catch (err) {
      // Restore env before downstream cleanup (markNeedsHuman uses Octokit
      // in-process, not gh, but tidiness is cheap).
      restoreEnv();
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, 'adapter threw');
      await this.markNeedsHuman(req, headlineFor('sdk_failure', req.method), message, log);
      await this.cleanupWorktree(req, log);
      this.completeWithFailure(req, startedAt, 'sdk_failure', message);
      return;
    }
    // Restore env on the success path too. Subsequent steps (label cleanup,
    // worktree teardown, putSession) don't need GH_TOKEN or KB vars.
    restoreEnv();

    // For `merge` jobs, never trust the model's self-reported success — a
    // misbehaving session can hallucinate `{merged: true}` after pushing
    // directly to the default branch and `gh pr close`-ing the PR (real
    // incident: agenti-fy/example-calc#52). Read the PR back from GitHub
    // and downgrade to task_error if it isn't actually merged.
    output = await this.verifyMergeOutcome(req, output, log);

    await this.handleOutcome(req, output, log);
    await this.cleanupWorktree(req, log);

    const persistable =
      SESSION_PERSISTENT_METHODS.has(req.method) &&
      (output.outcome === 'success' || output.outcome === 'task_error') &&
      output.sessionId !== null;
    if (persistable && output.sessionId) {
      try {
        await this.deps.coordinator.putSession(agentId, req.repo, output.sessionId);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'failed to persist session_id',
        );
      }
    }

    const usageFields: Pick<
      JobResult,
      'usage_input' | 'usage_output' | 'usage_cache_read' | 'usage_cache_write' | 'cost_usd'
    > = {};
    const u = output.usage;
    if (u) {
      if (typeof u['input_tokens'] === 'number') usageFields.usage_input = u['input_tokens'];
      if (typeof u['output_tokens'] === 'number') usageFields.usage_output = u['output_tokens'];
      if (typeof u['cache_read_input_tokens'] === 'number') usageFields.usage_cache_read = u['cache_read_input_tokens'];
      if (typeof u['cache_creation_input_tokens'] === 'number') usageFields.usage_cache_write = u['cache_creation_input_tokens'];
    }
    if (output.costUsd !== undefined) usageFields.cost_usd = output.costUsd;

    const result: JobResult = {
      job_id: req.job_id,
      method: req.method,
      repo: req.repo,
      target_id: req.target_id,
      outcome: output.outcome,
      session_id: output.sessionId,
      duration_ms: Date.now() - startedAt,
      artifacts: output.artifacts,
      ...(output.finalText ? { final_text: truncate(output.finalText, 16000) } : {}),
      ...(output.error ? { error: output.error } : {}),
      ...usageFields,
    };
    this.deps.state.completeJob(result);
    this.deps.metrics?.recordJob(req.method, output.outcome, result.duration_ms);
    this.deps.metrics?.recordTokens(output.usage);
    this.deps.metrics?.recordCost(req.method, output.costUsd);
    log.info(
      { outcome: output.outcome, duration_ms: result.duration_ms },
      'skill run finished',
    );
  }

  /**
   * Atomic transition: read all current labels, swap THIS persona's routing
   * label (`agent:<persona>:<method>`) for the matching in-progress marker
   * (`agent:<persona>:<method>-in-progress`), write back via setLabels. Other
   * personas' routing labels on the same target are left intact — that's
   * the whole point of the combined-label format: parallel reviewers don't
   * step on each other.
   */
  private async flipToInProgress(req: RunSkillRequest, log: Logger): Promise<void> {
    try {
      const route = routingLabel(req.persona_name, req.method);
      const inProg = inProgressLabel(req.persona_name, req.method);
      const current = await this.deps.github.listLabels(req.repo, req.target_id);
      const next = current.filter((l) => l !== route);
      if (!next.includes(inProg)) next.push(inProg);
      await this.deps.github.replaceLabels(req.repo, req.target_id, next);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'failed to flip in-progress label (continuing)',
      );
    }
  }

  /**
   * Defense against a hallucinated merge claim. The model can run any shell
   * command in the worktree (`gh pr close`, `git push origin HEAD:main`,
   * etc.) and then return `outcome: success` with `final_text` claiming the
   * PR was merged. Without this check, the runner clears routing labels and
   * the operator sees a successful job in the TUI even though the PR is
   * closed-not-merged.
   *
   * On a mismatch we mutate `output` in place: outcome → `task_error`, error
   * message describes the discrepancy. `handleOutcome` then runs its normal
   * needs-human flow, and the recorded JobResult reflects the truth.
   *
   * Verification failures (GitHub API blip, etc.) are non-fatal: we log a
   * warning and trust the model's report. The alternative — failing closed
   * on every API hiccup — would cause spurious needs-human flaps. The next
   * monitor tick catches a genuine bad-state PR anyway.
   */
  private async verifyMergeOutcome(
    req: RunSkillRequest,
    output: SkillRunOutput,
    log: Logger,
  ): Promise<SkillRunOutput> {
    if (req.method !== 'merge' || output.outcome !== 'success') return output;
    let pr: Awaited<ReturnType<GitHubAdapter['getPullRequest']>>;
    try {
      pr = await this.deps.github.getPullRequest(req.repo, req.target_id);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'merge verification: getPullRequest failed — skipping check',
      );
      return output;
    }
    // Null = no-github mode (stub/test environment with disabled GitHub).
    // We have nothing to verify against; trust the adapter's report.
    if (pr === null) return output;
    if (pr.merged && pr.state === 'closed') return output;

    const claimed = output.finalText ? truncate(output.finalText, 1500) : '(no final_text)';
    const message =
      `Merge skill reported success but GitHub disagrees. ` +
      `PR state=${pr.state}, merged=${pr.merged}, merge_commit_sha=${pr.mergeCommitSha ?? 'null'}. ` +
      `If the PR is closed without being merged, the agent likely closed it via \`gh pr close\` ` +
      `or pushed the resolved tree directly to the default branch — both are forbidden by the ` +
      `Merge skill's hard rules. Inspect the default branch's recent commits for any pushed ` +
      `directly by the bot. Agent's claim:\n\n${claimed}`;
    log.error(
      { pr_state: pr.state, pr_merged: pr.merged, merge_commit_sha: pr.mergeCommitSha },
      'merge verification failed — downgrading outcome to task_error',
    );
    return {
      ...output,
      outcome: 'task_error',
      error: { message },
    };
  }

  private async handleOutcome(
    req: RunSkillRequest,
    output: { outcome: JobOutcome; error?: { message: string } },
    log: Logger,
  ): Promise<void> {
    if (output.outcome === 'success') {
      try {
        // Remove BOTH this persona's in-progress marker AND its routing
        // label. If `flipToInProgress` failed silently (GitHub blip / rate
        // limit), the routing label is still on the issue; without
        // removing it here the work-poller's next tick would re-route the
        // same target — duplicate work, doubled child issues, doubled
        // cost. removeLabel treats 404 as the desired end state, so the
        // redundant remove of an already-absent label is a no-op. Other
        // personas' routing labels on the same target are left untouched.
        await this.deps.github.removeLabels(req.repo, req.target_id, [
          inProgressLabel(req.persona_name, req.method),
          routingLabel(req.persona_name, req.method),
        ]);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'failed to clear routing labels on success',
        );
      }
      return;
    }

    // Every non-success outcome must STOP the loop: clear in-progress, apply
    // needs-human, and record the failure context. Reverting to task:<method>
    // would let the work-poller re-route the same item — for sdk_failure/
    // auth_failure/config_failure that just retries the same broken state
    // forever (Anthropic tokens, GitHub API quota).
    const headline = headlineFor(output.outcome, req.method);
    await this.markNeedsHuman(req, headline, output.error?.message, log);
  }

  /**
   * Common failure path: post a comment with the headline + error context
   * (with issue-body fallback when comment posting fails), then atomically
   * swap in-progress for needs-human. Best-effort throughout — any single
   * step's failure is logged, not propagated.
   */
  private async markNeedsHuman(
    req: RunSkillRequest,
    headline: string,
    errorMessage: string | undefined,
    log: Logger,
  ): Promise<void> {
    const sig = this.signature();
    const message = errorMessage ?? 'no error message provided';
    const formatted = `${sig}\n\n---\n\n${headline}\n\n\`\`\`\n${truncate(message, 4000)}\n\`\`\``;
    let commentPosted = false;
    try {
      await this.deps.github.postIssueComment(req.repo, req.target_id, formatted);
      commentPosted = true;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'failed to post failure comment — will fall back to issue body',
      );
    }
    // Fallback channel: append the failure to the issue body so operators
    // see SOMETHING when comment posting failed (rate limits, perms). The
    // adapter does a read-modify-write so the operator's original issue
    // description is preserved — early versions REPLACED the body, which
    // silently destroyed user-authored content on every comment fallback.
    if (!commentPosted) {
      try {
        await this.deps.github.appendToIssueBody(
          req.repo,
          req.target_id,
          `---\n\n[agentify failure marker — could not post comment]\n${formatted}`,
        );
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'failed to record failure on issue body either',
        );
      }
    }
    try {
      const inProg = inProgressLabel(req.persona_name, req.method);
      const route = routingLabel(req.persona_name, req.method);
      const current = await this.deps.github.listLabels(req.repo, req.target_id);
      // Strip THIS persona's routing labels (in-progress + routable) and add
      // the global needs-human gate. Other personas' labels stay; needs-human
      // takes the WHOLE target out of routing per parseRoutingLabels.
      const next = current.filter((l) => l !== inProg && l !== route);
      if (!next.includes(NEEDS_HUMAN_LABEL)) next.push(NEEDS_HUMAN_LABEL);
      await this.deps.github.replaceLabels(req.repo, req.target_id, next);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'failed to apply needs-human label',
      );
    }
  }

  private async cleanupWorktree(req: RunSkillRequest, log: Logger): Promise<void> {
    try {
      await this.deps.worktreeManager.cleanup(req.repo, req.job_id);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'worktree cleanup failed',
      );
    }
    // Wiki cleanup is best-effort — WikiManager absorbs all errors internally.
    await this.deps.wikiManager.cleanup(req.repo, req.job_id);
  }

  private signature(): string {
    if (this.deps.soulRef.current.frontmatter.signature) return this.deps.soulRef.current.frontmatter.signature;
    if (isBuiltinPersona(this.deps.soulRef.current.frontmatter.type)) {
      return PERSONA_DEFAULTS[this.deps.soulRef.current.frontmatter.type].signature;
    }
    return this.deps.soulRef.current.frontmatter.name;
  }

  private completeWithFailure(
    req: RunSkillRequest,
    startedAt: number,
    outcome: Extract<JobOutcome, 'sdk_failure' | 'auth_failure' | 'config_failure'>,
    message: string,
  ): void {
    const duration_ms = Date.now() - startedAt;
    this.deps.state.completeJob({
      job_id: req.job_id,
      method: req.method,
      repo: req.repo,
      target_id: req.target_id,
      outcome,
      session_id: null,
      duration_ms,
      artifacts: {},
      error: { message },
    });
    this.deps.metrics?.recordJob(req.method, outcome, duration_ms);
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function headlineFor(outcome: JobOutcome, method: Method): string {
  switch (outcome) {
    case 'task_error':
      return `This ${method} run did not complete successfully:`;
    case 'sdk_failure':
      return `This ${method} run hit an internal SDK error and stopped. The agent has been marked FAILURE; clear via POST /reset after fixing the underlying issue. Details:`;
    case 'auth_failure':
      return `This ${method} run failed to authenticate (Anthropic or GitHub credentials). The agent has been marked FAILURE; verify credentials, then POST /reset. Details:`;
    case 'config_failure':
      return `This ${method} run failed during setup (worktree, SOUL, or config). Details:`;
    default:
      return `This ${method} run ended with outcome=${outcome}:`;
  }
}
