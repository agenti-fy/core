import { describe, it, expect } from 'vitest';
import {
  desiredRoutingLabels,
  type PrSnapshot,
  type ReviewSnapshot,
  __test,
} from './pr-monitor.js';

const REQUIRED = ['conductor', 'skeptic', 'scribe', 'crafter'] as const;
const config = { requiredReviewers: REQUIRED };

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
