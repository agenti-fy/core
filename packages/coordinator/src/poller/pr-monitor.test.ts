import { describe, it, expect, vi } from 'vitest';
import {
  desiredRoutingLabels,
  monitorPullRequests,
  shouldDispatchReviewLabel,
  type PrMonitorConfig,
  type PrSnapshot,
  type ReviewSnapshot,
  __test,
} from './pr-monitor.js';

const REQUIRED = ['conductor', 'skeptic', 'scribe', 'crafter'] as const;
const config: PrMonitorConfig = { requiredReviewers: REQUIRED, maxReviewCycles: 5 };

function review(
  authorPersona: string | null,
  state: ReviewSnapshot['state'],
  commitId = 'sha-head',
  submittedAt = '2026-01-01T00:00:00Z',
): ReviewSnapshot {
  return { authorPersona, state, commitId, submittedAt };
}

function pr(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: 1,
    authorPersona: 'tinkerer',
    headSha: 'sha-head',
    labels: [],
    reviews: [],
    ...over,
  };
}

describe('desiredRoutingLabels', () => {
  it('returns null (hands-off) when needs-human is set', () => {
    expect(
      desiredRoutingLabels(pr({ labels: ['needs-human', 'agent:conductor:review'] }), config),
    ).toBeNull();
  });

  it('routes to author:address-review when any reviewer requested changes on current HEAD', () => {
    expect(
      desiredRoutingLabels(
        pr({
          authorPersona: 'tinkerer',
          reviews: [review('skeptic', 'CHANGES_REQUESTED')],
        }),
        config,
      ),
    ).toEqual(['agent:tinkerer:address-review']);
  });

  it('does not re-add address-review when its in-progress marker is already set', () => {
    expect(
      desiredRoutingLabels(
        pr({
          authorPersona: 'tinkerer',
          labels: ['agent:tinkerer:address-review-in-progress'],
          reviews: [review('skeptic', 'CHANGES_REQUESTED')],
        }),
        config,
      ),
    ).toEqual([]);
  });

  it('returns [] (no auto-route) when CHANGES_REQUESTED but author is non-agent', () => {
    expect(
      desiredRoutingLabels(
        pr({
          authorPersona: null,
          reviews: [review('skeptic', 'CHANGES_REQUESTED')],
        }),
        config,
      ),
    ).toEqual([]);
  });

  it('routes to conductor:merge when all required reviewers (sans author) approved on current HEAD', () => {
    expect(
      desiredRoutingLabels(
        pr({
          authorPersona: 'tinkerer',
          reviews: [
            review('conductor', 'APPROVED'),
            review('skeptic', 'APPROVED'),
            review('scribe', 'APPROVED'),
            review('crafter', 'APPROVED'),
          ],
        }),
        config,
      ),
    ).toEqual(['agent:conductor:merge']);
  });

  it('does not re-add merge when conductor:merge in-progress marker is already set', () => {
    expect(
      desiredRoutingLabels(
        pr({
          authorPersona: 'tinkerer',
          labels: ['agent:conductor:merge-in-progress'],
          reviews: [
            review('conductor', 'APPROVED'),
            review('skeptic', 'APPROVED'),
            review('scribe', 'APPROVED'),
            review('crafter', 'APPROVED'),
          ],
        }),
        config,
      ),
    ).toEqual([]);
  });

  it('exempts the author from required-reviewer set (agent-authored PR)', () => {
    // Author is conductor — only skeptic/scribe/crafter need to approve.
    expect(
      desiredRoutingLabels(
        pr({
          authorPersona: 'conductor',
          reviews: [
            review('skeptic', 'APPROVED'),
            review('scribe', 'APPROVED'),
            review('crafter', 'APPROVED'),
          ],
        }),
        config,
      ),
    ).toEqual(['agent:conductor:merge']);
  });

  it('emits review labels for reviewers with no verdict on current HEAD', () => {
    const labels = desiredRoutingLabels(pr({ authorPersona: 'tinkerer' }), config) ?? [];
    expect(labels.sort()).toEqual(
      [
        'agent:conductor:review',
        'agent:skeptic:review',
        'agent:scribe:review',
        'agent:crafter:review',
      ].sort(),
    );
  });

  it('treats stale APPROVED on a non-HEAD commit as still open', () => {
    const labels = desiredRoutingLabels(
      pr({
        authorPersona: 'tinkerer',
        headSha: 'sha-head',
        reviews: [
          review('conductor', 'APPROVED', 'sha-OLD'),
          review('skeptic', 'APPROVED'),
          review('scribe', 'APPROVED'),
          review('crafter', 'APPROVED'),
        ],
      }),
      config,
    ) ?? [];
    // conductor approved but on an old commit → still open → review label only
    // for conductor; merge gate doesn't fire.
    expect(labels).toEqual(['agent:conductor:review']);
  });

  it('treats COMMENTED on current HEAD as still open (no verdict)', () => {
    const labels = desiredRoutingLabels(
      pr({
        authorPersona: 'tinkerer',
        reviews: [
          review('conductor', 'COMMENTED'),
          review('skeptic', 'APPROVED'),
          review('scribe', 'APPROVED'),
          review('crafter', 'APPROVED'),
        ],
      }),
      config,
    ) ?? [];
    expect(labels).toEqual(['agent:conductor:review']);
  });

  it('skips re-adding a reviewer label whose review-in-progress marker is set', () => {
    const labels = desiredRoutingLabels(
      pr({
        authorPersona: 'tinkerer',
        labels: ['agent:skeptic:review-in-progress'],
      }),
      config,
    ) ?? [];
    expect(labels.sort()).toEqual(
      [
        'agent:conductor:review',
        'agent:scribe:review',
        'agent:crafter:review',
      ].sort(),
    );
  });

  it('uses LATEST review per reviewer on current HEAD (newer trumps older)', () => {
    // Reviewer first commented, then later approved on the same HEAD.
    const labels = desiredRoutingLabels(
      pr({
        authorPersona: 'tinkerer',
        reviews: [
          review('conductor', 'COMMENTED', 'sha-head', '2026-01-01T00:00:00Z'),
          review('conductor', 'APPROVED', 'sha-head', '2026-01-02T00:00:00Z'),
          review('skeptic', 'APPROVED'),
          review('scribe', 'APPROVED'),
          review('crafter', 'APPROVED'),
        ],
      }),
      config,
    );
    expect(labels).toEqual(['agent:conductor:merge']);
  });

  it('CHANGES_REQUESTED beats APPROVED when both exist on current HEAD (latest wins)', () => {
    // Reviewer approved, then later requested changes.
    expect(
      desiredRoutingLabels(
        pr({
          authorPersona: 'tinkerer',
          reviews: [
            review('skeptic', 'APPROVED', 'sha-head', '2026-01-01T00:00:00Z'),
            review('skeptic', 'CHANGES_REQUESTED', 'sha-head', '2026-01-02T00:00:00Z'),
          ],
        }),
        config,
      ),
    ).toEqual(['agent:tinkerer:address-review']);
  });

  it('ignores DISMISSED reviews', () => {
    // Dismissed CHANGES_REQUESTED shouldn't trigger address-review.
    const labels = desiredRoutingLabels(
      pr({
        authorPersona: 'tinkerer',
        reviews: [
          review('skeptic', 'DISMISSED'),
          review('conductor', 'APPROVED'),
          review('scribe', 'APPROVED'),
          review('crafter', 'APPROVED'),
        ],
      }),
      config,
    ) ?? [];
    // skeptic still owes a current verdict → review label.
    expect(labels).toEqual(['agent:skeptic:review']);
  });
});

describe('shouldDispatchReviewLabel', () => {
  it('returns true when no previous SHA record (first dispatch)', () => {
    expect(shouldDispatchReviewLabel('skeptic', pr(), null)).toBe(true);
  });

  it('returns true when HEAD SHA differs from last labeled SHA', () => {
    expect(
      shouldDispatchReviewLabel('skeptic', pr({ headSha: 'sha-new' }), 'sha-old'),
    ).toBe(true);
  });

  it('returns true when HEAD SHA is unchanged but persona has NO review on this HEAD (prior dispatch failed)', () => {
    // Recovery path: skeptic was labeled at sha-A earlier, hit a hijack flag /
    // crash / reset before producing a review. Operator clears needs-human
    // and re-adds the label. We must allow re-dispatch — otherwise the label
    // gets stripped within ~30s and the reviewer never runs.
    expect(
      shouldDispatchReviewLabel('skeptic', pr({ headSha: 'sha-A', reviews: [] }), 'sha-A'),
    ).toBe(true);
  });

  it('returns true when HEAD SHA unchanged, lastLabeled matches, but only OTHER personas reviewed', () => {
    // Same recovery path as above, with reviews from peers present. The
    // suppression must look at THIS persona's reviews, not anyone's.
    expect(
      shouldDispatchReviewLabel(
        'skeptic',
        pr({
          headSha: 'sha-A',
          reviews: [
            review('conductor', 'APPROVED', 'sha-A'),
            review('scribe', 'APPROVED', 'sha-A'),
          ],
        }),
        'sha-A',
      ),
    ).toBe(true);
  });

  it('returns false when HEAD SHA unchanged and persona has a current-HEAD verdict (no stale CHANGES_REQUESTED)', () => {
    // True duplicate suppression: skeptic already approved this exact SHA.
    // Re-labeling would dispatch a redundant review.
    expect(
      shouldDispatchReviewLabel(
        'skeptic',
        pr({ headSha: 'sha-A', reviews: [review('skeptic', 'APPROVED', 'sha-A')] }),
        'sha-A',
      ),
    ).toBe(false);
  });

  it('returns false when HEAD SHA unchanged and CHANGES_REQUESTED is on the current HEAD (not stale)', () => {
    expect(
      shouldDispatchReviewLabel(
        'skeptic',
        pr({ headSha: 'sha-A', reviews: [review('skeptic', 'CHANGES_REQUESTED', 'sha-A')] }),
        'sha-A',
      ),
    ).toBe(false);
  });

  it('returns true when HEAD SHA unchanged but CHANGES_REQUESTED from persona is on an older commit', () => {
    // Reviewer requested changes on sha-OLD; author pushed no new commit (still sha-A)
    // but we should allow re-dispatch so the reviewer can confirm their concern was addressed.
    expect(
      shouldDispatchReviewLabel(
        'skeptic',
        pr({
          headSha: 'sha-A',
          reviews: [review('skeptic', 'CHANGES_REQUESTED', 'sha-OLD')],
        }),
        'sha-A',
      ),
    ).toBe(true);
  });

  it('returns false when stale CHANGES_REQUESTED is from a different persona (and target persona already approved this HEAD)', () => {
    // Conductor approved this exact SHA; another persona's stale CR shouldn't
    // make us re-dispatch conductor. Without the current-verdict requirement,
    // any stale CR from anyone could leak suppression for everyone.
    expect(
      shouldDispatchReviewLabel(
        'conductor',
        pr({
          headSha: 'sha-A',
          reviews: [
            review('conductor', 'APPROVED', 'sha-A'),
            review('skeptic', 'CHANGES_REQUESTED', 'sha-OLD'),
          ],
        }),
        'sha-A',
      ),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* monitorPullRequests integration: SHA-skip and cycle-cap              */
/* ------------------------------------------------------------------ */

type StoreState = {
  labeledShas: Map<string, string>;
  cycleCounts: Map<string, number>;
};

function makeStore(init: Partial<StoreState> = {}) {
  const s: StoreState = {
    labeledShas: init.labeledShas ?? new Map(),
    cycleCounts: init.cycleCounts ?? new Map(),
  };
  const shaKey = (repo: string, pr: number, persona: string) => `${repo}:${pr}:${persona}`;
  const prKey = (repo: string, pr: number) => `${repo}:${pr}`;
  return {
    // required by monitorPullRequests
    listRepos: () => [{ repo: 'owner/repo', active: true, poll_interval_s: 30, last_polled: null }],
    getLastLabeledSha: (repo: string, prNum: number, persona: string): string | null =>
      s.labeledShas.get(shaKey(repo, prNum, persona)) ?? null,
    recordLabeledSha: (repo: string, prNum: number, persona: string, sha: string) => {
      s.labeledShas.set(shaKey(repo, prNum, persona), sha);
    },
    hasAnyLabeledSha: (repo: string, prNum: number): boolean =>
      [...s.labeledShas.keys()].some((k) => k.startsWith(`${repo}:${prNum}:`)),
    getReviewCycleCount: (repo: string, prNum: number): number =>
      s.cycleCounts.get(prKey(repo, prNum)) ?? 0,
    incrementReviewCycleCount: (repo: string, prNum: number): number => {
      const next = (s.cycleCounts.get(prKey(repo, prNum)) ?? 0) + 1;
      s.cycleCounts.set(prKey(repo, prNum), next);
      return next;
    },
    // expose state for assertions
    _state: s,
  };
}

function makePrApiData(
  prNumber: number,
  headSha: string,
  labels: string[],
  reviews: ReviewSnapshot[],
) {
  return {
    number: prNumber,
    head: { sha: headSha },
    user: { login: 'agenti-fy-tinkerer[bot]' },
    labels: labels.map((name) => ({ name })),
    _reviews: reviews,
  };
}

function makeGitHub(
  prs: ReturnType<typeof makePrApiData>[],
) {
  const setLabels = vi.fn().mockResolvedValue({});
  const createComment = vi.fn().mockResolvedValue({});
  return {
    paginate: {
      iterator: async function* (
        _fn: unknown,
        _opts: unknown,
      ): AsyncGenerator<{ data: typeof prs }> {
        yield { data: prs };
      },
    },
    pulls: {
      list: vi.fn(),
      listReviews: vi.fn().mockImplementation(
        async ({ pull_number }: { pull_number: number }) => ({
          data: (prs.find((p) => p.number === pull_number)?._reviews ?? []).map((r) => ({
            user: { login: r.authorPersona ? `agenti-fy-${r.authorPersona}[bot]` : null },
            state: r.state,
            commit_id: r.commitId,
            submitted_at: r.submittedAt,
          })),
        }),
      ),
    },
    issues: { setLabels, createComment },
  };
}

const monitorConfig: PrMonitorConfig = { requiredReviewers: ['skeptic'], maxReviewCycles: 3 };
const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
} as unknown as Parameters<typeof monitorPullRequests>[3];

describe('monitorPullRequests — SHA-skip guard', () => {
  it('skips reviewer label when HEAD SHA is unchanged AND persona already produced a verdict on this HEAD', async () => {
    // Two required reviewers: skeptic finished APPROVE on this SHA, conductor
    // hasn't reviewed at all (no lastLabeledSha → not suppressed). The output
    // routing should be just `agent:conductor:review` — skeptic must be
    // omitted because its verdict is already current.
    const config: PrMonitorConfig = {
      requiredReviewers: ['skeptic', 'conductor'],
      maxReviewCycles: 3,
    };
    const store = makeStore({
      labeledShas: new Map([['owner/repo:1:skeptic', 'sha-head']]),
    });
    const prData = makePrApiData(1, 'sha-head', [], [
      { authorPersona: 'skeptic', state: 'APPROVED', commitId: 'sha-head', submittedAt: '2026-01-01T00:00:00Z' },
    ]);
    const github = makeGitHub([prData]);

    await monitorPullRequests(github as never, store as never, config, noopLogger);

    expect(github.issues.setLabels).toHaveBeenCalledOnce();
    const { labels } = github.issues.setLabels.mock.calls[0]![0];
    expect(labels).toContain('agent:conductor:review');
    expect(labels).not.toContain('agent:skeptic:review');
  });

  it('re-dispatches reviewer when HEAD SHA matches but persona produced no review (recovery path)', async () => {
    // The dispatch landed but the agent never finished — hijack flag,
    // crash, /reset, etc. Operator clears needs-human, expects re-dispatch.
    const store = makeStore({
      labeledShas: new Map([['owner/repo:1:skeptic', 'sha-head']]),
    });
    const prData = makePrApiData(1, 'sha-head', [], []);
    const github = makeGitHub([prData]);

    await monitorPullRequests(github as never, store as never, monitorConfig, noopLogger);

    expect(github.issues.setLabels).toHaveBeenCalledOnce();
    const { labels } = github.issues.setLabels.mock.calls[0]![0];
    expect(labels).toContain('agent:skeptic:review');
  });

  it('dispatches reviewer label when HEAD SHA changed', async () => {
    const store = makeStore({
      labeledShas: new Map([['owner/repo:1:skeptic', 'sha-old']]),
    });
    const prData = makePrApiData(1, 'sha-new', [], []);
    const github = makeGitHub([prData]);

    await monitorPullRequests(github as never, store as never, monitorConfig, noopLogger);

    expect(github.issues.setLabels).toHaveBeenCalledOnce();
    const { labels } = github.issues.setLabels.mock.calls[0]![0];
    expect(labels).toContain('agent:skeptic:review');
  });

  it('re-dispatches reviewer when same HEAD SHA but persona has stale CHANGES_REQUESTED', async () => {
    const store = makeStore({
      labeledShas: new Map([['owner/repo:1:skeptic', 'sha-A']]),
    });
    // CHANGES_REQUESTED from skeptic on an older commit — author hasn't pushed new code
    // but the reviewer flagged something and never got a re-review
    const prData = makePrApiData(1, 'sha-A', [], [
      review('skeptic', 'CHANGES_REQUESTED', 'sha-OLD'),
    ]);
    const github = makeGitHub([prData]);

    await monitorPullRequests(github as never, store as never, monitorConfig, noopLogger);

    expect(github.issues.setLabels).toHaveBeenCalledOnce();
    const { labels } = github.issues.setLabels.mock.calls[0]![0];
    expect(labels).toContain('agent:skeptic:review');
  });

  it('records the HEAD SHA after successfully dispatching reviewer labels', async () => {
    const store = makeStore(); // no prior records
    const prData = makePrApiData(1, 'sha-first', [], []);
    const github = makeGitHub([prData]);

    await monitorPullRequests(github as never, store as never, monitorConfig, noopLogger);

    expect(store._state.labeledShas.get('owner/repo:1:skeptic')).toBe('sha-first');
  });
});

describe('monitorPullRequests — review-cycle cap', () => {
  it('applies needs-human and posts comment when cycle count hits the cap', async () => {
    const store = makeStore({
      // Prior dispatches recorded — this is not the first review
      labeledShas: new Map([['owner/repo:1:skeptic', 'sha-old']]),
      // Already hit the cap (count === maxReviewCycles === 3)
      cycleCounts: new Map([['owner/repo:1', 3]]),
    });
    const prData = makePrApiData(1, 'sha-new', [], []);
    const github = makeGitHub([prData]);

    await monitorPullRequests(github as never, store as never, monitorConfig, noopLogger);

    expect(github.issues.setLabels).toHaveBeenCalledOnce();
    const { labels } = github.issues.setLabels.mock.calls[0]![0];
    expect(labels).toContain('needs-human');
    expect(labels).not.toContain('agent:skeptic:review');
    expect(github.issues.createComment).toHaveBeenCalledOnce();
  });

  it('does not cap on the first review dispatch (no prior labeled SHA)', async () => {
    const store = makeStore(); // pristine — first dispatch
    const prData = makePrApiData(1, 'sha-first', [], []);
    const github = makeGitHub([prData]);

    await monitorPullRequests(github as never, store as never, monitorConfig, noopLogger);

    expect(github.issues.setLabels).toHaveBeenCalledOnce();
    const { labels } = github.issues.setLabels.mock.calls[0]![0];
    expect(labels).toContain('agent:skeptic:review');
    expect(labels).not.toContain('needs-human');
    // Cycle counter must NOT be incremented on the first dispatch
    expect(store._state.cycleCounts.get('owner/repo:1') ?? 0).toBe(0);
  });

  it('increments cycle count on re-dispatch when below the cap', async () => {
    const store = makeStore({
      labeledShas: new Map([['owner/repo:1:skeptic', 'sha-old']]),
      cycleCounts: new Map([['owner/repo:1', 1]]),
    });
    const prData = makePrApiData(1, 'sha-new', [], []);
    const github = makeGitHub([prData]);

    await monitorPullRequests(github as never, store as never, monitorConfig, noopLogger);

    expect(github.issues.setLabels).toHaveBeenCalledOnce();
    expect(store._state.cycleCounts.get('owner/repo:1')).toBe(2);
  });

  it('allows the last cycle before the cap', async () => {
    // count = 2, cap = 3: should still dispatch (not cap until count >= 3)
    const store = makeStore({
      labeledShas: new Map([['owner/repo:1:skeptic', 'sha-old']]),
      cycleCounts: new Map([['owner/repo:1', 2]]),
    });
    const prData = makePrApiData(1, 'sha-new', [], []);
    const github = makeGitHub([prData]);

    await monitorPullRequests(github as never, store as never, monitorConfig, noopLogger);

    expect(github.issues.setLabels).toHaveBeenCalledOnce();
    const { labels } = github.issues.setLabels.mock.calls[0]![0];
    expect(labels).toContain('agent:skeptic:review');
    expect(labels).not.toContain('needs-human');
  });
});

describe('personaFromLogin', () => {
  const { personaFromLogin } = __test;

  it('parses agenti-fy-<persona>[bot] form', () => {
    expect(personaFromLogin('agenti-fy-skeptic[bot]')).toBe('skeptic');
    expect(personaFromLogin('agenti-fy-conductor[bot]')).toBe('conductor');
  });

  it('returns null for unrecognized persona segment', () => {
    expect(personaFromLogin('agenti-fy-randomname[bot]')).toBeNull();
  });

  it('returns null for non-bot logins', () => {
    expect(personaFromLogin('alex')).toBeNull();
    expect(personaFromLogin('agenti-fy-skeptic')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(personaFromLogin(null)).toBeNull();
    expect(personaFromLogin(undefined)).toBeNull();
  });
});
