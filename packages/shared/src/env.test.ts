import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { boolFlag, normalizePrivateKey } from './env.js';

describe('boolFlag', () => {
  const schema = z.object({ flag: boolFlag(false) });
  const truthy = (v: string | undefined | boolean): boolean => schema.parse({ flag: v }).flag;

  it('treats canonical truthy strings as true', () => {
    expect(truthy('1')).toBe(true);
    expect(truthy('true')).toBe(true);
    expect(truthy('TRUE')).toBe(true);
    expect(truthy('yes')).toBe(true);
    expect(truthy('on')).toBe(true);
    expect(truthy(true)).toBe(true);
  });

  it('treats canonical falsy strings as false (the JS Boolean footgun fix)', () => {
    expect(truthy('0')).toBe(false);
    expect(truthy('false')).toBe(false);
    expect(truthy('FALSE')).toBe(false);
    expect(truthy('no')).toBe(false);
    expect(truthy('off')).toBe(false);
    expect(truthy('')).toBe(false);
    expect(truthy(false)).toBe(false);
  });

  it('uses the default when undefined', () => {
    expect(truthy(undefined)).toBe(false);
    const trueDefault = z.object({ flag: boolFlag(true) });
    expect(trueDefault.parse({}).flag).toBe(true);
  });

  it('falls back to default for unknown strings', () => {
    expect(truthy('maybe')).toBe(false);
  });
});

describe('normalizePrivateKey', () => {
  it('replaces literal \\n with real newlines', () => {
    expect(normalizePrivateKey('a\\nb\\nc')).toBe('a\nb\nc');
  });
  it('passes through real newlines unchanged', () => {
    expect(normalizePrivateKey('a\nb\nc')).toBe('a\nb\nc');
  });
});
