import { describe, it, expect } from 'vitest';
import { inProgressLabel, parseRoutingLabel, routingLabel } from './labels.js';
import { METHODS } from './methods.js';

describe('routingLabel / inProgressLabel', () => {
  it('builds a routing label as agent:<persona>:<method>', () => {
    expect(routingLabel('conductor', 'review')).toBe('agent:conductor:review');
    expect(routingLabel('skeptic', 'address_review')).toBe('agent:skeptic:address-review');
  });

  it('builds an in-progress marker by suffixing -in-progress', () => {
    expect(inProgressLabel('conductor', 'review')).toBe('agent:conductor:review-in-progress');
    expect(inProgressLabel('tinkerer', 'address_review')).toBe(
      'agent:tinkerer:address-review-in-progress',
    );
  });

  it('every method round-trips through routingLabel + parseRoutingLabel', () => {
    for (const m of METHODS) {
      const lbl = routingLabel('tinkerer', m);
      const parsed = parseRoutingLabel(lbl);
      expect(parsed).not.toBeNull();
      expect(parsed?.persona).toBe('tinkerer');
      expect(parsed?.method).toBe(m);
      expect(parsed?.inProgress).toBe(false);
    }
  });
});

describe('parseRoutingLabel', () => {
  it('parses a routing label with a built-in persona', () => {
    expect(parseRoutingLabel('agent:tinkerer:plan')).toEqual({
      persona: 'tinkerer',
      personaType: 'tinkerer',
      method: 'plan',
      inProgress: false,
    });
  });

  it('classifies non-builtin persona as personaType=custom', () => {
    expect(parseRoutingLabel('agent:my-bespoke-bot:implement')).toEqual({
      persona: 'my-bespoke-bot',
      personaType: 'custom',
      method: 'implement',
      inProgress: false,
    });
  });

  it('detects in-progress markers — including the address-review-in-progress edge case', () => {
    expect(parseRoutingLabel('agent:tinkerer:plan-in-progress')).toEqual({
      persona: 'tinkerer',
      personaType: 'tinkerer',
      method: 'plan',
      inProgress: true,
    });
    expect(parseRoutingLabel('agent:skeptic:address-review-in-progress')).toEqual({
      persona: 'skeptic',
      personaType: 'skeptic',
      method: 'address_review',
      inProgress: true,
    });
  });

  it('returns null for non-routing labels', () => {
    expect(parseRoutingLabel('halt-agents')).toBeNull();
    expect(parseRoutingLabel('needs-human')).toBeNull();
    expect(parseRoutingLabel('bug')).toBeNull();
  });

  it('returns null for malformed routing labels', () => {
    expect(parseRoutingLabel('agent:')).toBeNull();
    expect(parseRoutingLabel('agent:tinkerer:')).toBeNull();
    expect(parseRoutingLabel('agent::plan')).toBeNull();
    expect(parseRoutingLabel('agent:tinkerer')).toBeNull();
  });

  it('returns null for unknown methods', () => {
    expect(parseRoutingLabel('agent:tinkerer:nonsense')).toBeNull();
    expect(parseRoutingLabel('agent:tinkerer:nonsense-in-progress')).toBeNull();
  });
});
