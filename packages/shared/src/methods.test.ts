import { describe, it, expect } from 'vitest';
import { METHODS, METHOD_PRIORITY, compareMethodsByPriority } from './methods.js';

describe('METHOD_PRIORITY', () => {
  it('assigns strictly descending values for the canonical method order', () => {
    expect(METHOD_PRIORITY.merge).toBeGreaterThan(METHOD_PRIORITY.address_review);
    expect(METHOD_PRIORITY.address_review).toBeGreaterThan(METHOD_PRIORITY.review);
    expect(METHOD_PRIORITY.review).toBeGreaterThan(METHOD_PRIORITY.implement);
    expect(METHOD_PRIORITY.implement).toBeGreaterThan(METHOD_PRIORITY.plan);
  });

  it('has an entry for every value in METHODS (exhaustiveness guard)', () => {
    for (const m of METHODS) {
      expect(m in METHOD_PRIORITY).toBe(true);
    }
  });
});

describe('compareMethodsByPriority', () => {
  it('sorts an unordered method array into lifecycle-late-first order', () => {
    const input: Array<typeof METHODS[number]> = [
      'plan',
      'merge',
      'review',
      'implement',
      'address_review',
    ];
    const result = [...input].sort(compareMethodsByPriority);
    expect(result).toEqual(['merge', 'address_review', 'review', 'implement', 'plan']);
  });
});
