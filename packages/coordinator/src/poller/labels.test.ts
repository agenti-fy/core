import { describe, it, expect } from 'vitest';
import { hasHaltLabel, parseRoutingLabels } from './labels.js';

describe('parseRoutingLabels', () => {
  it('returns [] when no routing labels are present', () => {
    expect(parseRoutingLabels([])).toEqual([]);
    expect(parseRoutingLabels(['unrelated', 'bug'])).toEqual([]);
  });

  it('returns one routing for a single agent:<persona>:<method> label', () => {
    expect(parseRoutingLabels(['agent:tinkerer:plan'])).toEqual([
      { persona: 'tinkerer', personaType: 'tinkerer', method: 'plan', inProgress: false },
    ]);
  });

  it('returns ALL routings when multiple personas claim the same target', () => {
    // The motivating use case: four mandatory reviewers on one PR run in parallel.
    const labels = [
      'agent:conductor:review',
      'agent:skeptic:review',
      'agent:scribe:review',
      'agent:crafter:review',
    ];
    const out = parseRoutingLabels(labels);
    expect(out.map((r) => r.persona).sort()).toEqual(
      ['conductor', 'crafter', 'scribe', 'skeptic'].sort(),
    );
    expect(out.every((r) => r.method === 'review')).toBe(true);
  });

  it('handles the address-review kebab-case slug', () => {
    expect(parseRoutingLabels(['agent:tinkerer:address-review'])).toEqual([
      {
        persona: 'tinkerer',
        personaType: 'tinkerer',
        method: 'address_review',
        inProgress: false,
      },
    ]);
  });

  it('skips a routing whose own (persona, method) in-progress marker is set', () => {
    expect(
      parseRoutingLabels(['agent:tinkerer:plan', 'agent:tinkerer:plan-in-progress']),
    ).toEqual([]);
  });

  it("does NOT skip a routing when ANOTHER persona's in-progress marker is set", () => {
    // Conductor still owes its review even though skeptic's is in flight.
    const out = parseRoutingLabels([
      'agent:conductor:review',
      'agent:skeptic:review-in-progress',
    ]);
    expect(out).toEqual([
      { persona: 'conductor', personaType: 'conductor', method: 'review', inProgress: false },
    ]);
  });

  it('classifies non-builtin persona as custom', () => {
    expect(parseRoutingLabels(['agent:my-bespoke-bot:plan'])).toEqual([
      { persona: 'my-bespoke-bot', personaType: 'custom', method: 'plan', inProgress: false },
    ]);
  });

  it('returns [] when needs-human is set even if routings are present', () => {
    // Spec §8.1: needs-human takes the item out of the routing pool until a
    // human removes it.
    expect(
      parseRoutingLabels(['agent:tinkerer:plan', 'agent:skeptic:review', 'needs-human']),
    ).toEqual([]);
  });

  it('ignores malformed routing labels gracefully', () => {
    expect(
      parseRoutingLabels(['agent:tinkerer:plan', 'agent:', 'agent:tinkerer:nonsense']),
    ).toEqual([
      { persona: 'tinkerer', personaType: 'tinkerer', method: 'plan', inProgress: false },
    ]);
  });
});

describe('hasHaltLabel', () => {
  it('detects the halt label', () => {
    expect(hasHaltLabel(['halt-agents'])).toBe(true);
    expect(hasHaltLabel(['agent:tinkerer:plan'])).toBe(false);
  });
});
