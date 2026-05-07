import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

/** Minimal env that satisfies the GitHub-credential requirement while running
 *  offline.  Setting DISABLE_GITHUB=true skips the superRefine check so we
 *  don't need dummy App credentials in unit tests. */
const BASE_ENV: NodeJS.ProcessEnv = {
  DISABLE_GITHUB: 'true',
};

describe('loadConfig — all-defaults baseline', () => {
  it('returns schema defaults for every number field when env vars are unset', () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect(cfg.port).toBe(8080);
    expect(cfg.defaultPollIntervalSeconds).toBe(30);
    expect(cfg.installationRefreshSeconds).toBe(300);
    expect(cfg.jobCompletionPollSeconds).toBe(5);
    expect(cfg.workPollSeconds).toBe(30);
    expect(cfg.failedDispatchRetentionDays).toBe(7);
    expect(cfg.completedJobRetentionDays).toBe(30);
    expect(cfg.staleJobTimeoutSeconds).toBe(30 * 60);
    expect(cfg.staleJobSweepSeconds).toBe(10 * 60);
    expect(cfg.planCompletionPollSeconds).toBe(60);
    expect(cfg.prMonitorIntervalSeconds).toBe(30);
    expect(cfg.prMaxReviewCycles).toBe(5);
  });
});

describe('loadConfig — empty-string regression (compose ${VAR-} expansion)', () => {
  const emptyFields: [string, string, number][] = [
    ['PORT', 'port', 8080],
    ['DEFAULT_POLL_INTERVAL_S', 'defaultPollIntervalSeconds', 30],
    ['INSTALLATION_REFRESH_S', 'installationRefreshSeconds', 300],
    ['JOB_COMPLETION_POLL_S', 'jobCompletionPollSeconds', 5],
    ['WORK_POLL_S', 'workPollSeconds', 30],
    ['FAILED_DISPATCH_RETENTION_DAYS', 'failedDispatchRetentionDays', 7],
    ['COMPLETED_JOB_RETENTION_DAYS', 'completedJobRetentionDays', 30],
    ['STALE_JOB_TIMEOUT_S', 'staleJobTimeoutSeconds', 30 * 60],
    ['STALE_JOB_SWEEP_S', 'staleJobSweepSeconds', 10 * 60],
    ['PLAN_COMPLETION_POLL_S', 'planCompletionPollSeconds', 60],
    ['PR_MONITOR_INTERVAL_S', 'prMonitorIntervalSeconds', 30],
    ['PR_MAX_REVIEW_CYCLES', 'prMaxReviewCycles', 5],
  ];

  it.each(emptyFields)(
    '%s="" falls back to schema default (%i), does not throw',
    (envVar, cfgKey, expectedDefault) => {
      const cfg = loadConfig({ ...BASE_ENV, [envVar]: '' });
      expect((cfg as Record<string, unknown>)[cfgKey]).toBe(expectedDefault);
    },
  );
});

describe('loadConfig — positive overrides', () => {
  it('accepts an explicit numeric value for PORT', () => {
    const cfg = loadConfig({ ...BASE_ENV, PORT: '9090' });
    expect(cfg.port).toBe(9090);
  });

  it('accepts an explicit value for defaultPollIntervalSeconds', () => {
    const cfg = loadConfig({ ...BASE_ENV, DEFAULT_POLL_INTERVAL_S: '60' });
    expect(cfg.defaultPollIntervalSeconds).toBe(60);
  });

  it('accepts an explicit value for prMaxReviewCycles', () => {
    const cfg = loadConfig({ ...BASE_ENV, PR_MAX_REVIEW_CYCLES: '10' });
    expect(cfg.prMaxReviewCycles).toBe(10);
  });

  it('rejects non-positive values for staleJobTimeoutSeconds', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, STALE_JOB_TIMEOUT_S: '0' }),
    ).toThrow();
  });
});
