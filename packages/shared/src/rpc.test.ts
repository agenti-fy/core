import { describe, it, expect } from 'vitest';
import { DispatchRequestSchema, RegisterRequestSchema } from './rpc.js';

const VALID_REGISTER_BASE = {
  name: 'tinkerer',
  type: 'tinkerer' as const,
  version: '1.0.0',
  url: 'http://localhost:3000',
  supported_methods: ['implement' as const],
};

const VALID_DISPATCH_BASE = {
  job_id: 'job-123',
  repo: 'acme/api',
  id: 42,
  session_id: null,
  persona_name: 'tinkerer',
};

describe('RegisterRequestSchema.name uses PersonaNameSchema', () => {
  it('accepts valid persona names', () => {
    expect(RegisterRequestSchema.safeParse({ ...VALID_REGISTER_BASE, name: 'tinkerer' }).success).toBe(true);
    expect(RegisterRequestSchema.safeParse({ ...VALID_REGISTER_BASE, name: 'my-custom-bot' }).success).toBe(true);
    expect(RegisterRequestSchema.safeParse({ ...VALID_REGISTER_BASE, name: 'bot_v2' }).success).toBe(true);
  });

  it('rejects shell-injection persona name $(echo pwned)', () => {
    const result = RegisterRequestSchema.safeParse({
      ...VALID_REGISTER_BASE,
      name: '$(echo pwned)',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('^[a-z][a-z0-9_-]{0,31}$');
    }
  });

  it('rejects empty string', () => {
    expect(RegisterRequestSchema.safeParse({ ...VALID_REGISTER_BASE, name: '' }).success).toBe(false);
  });

  it('rejects names with uppercase letters', () => {
    expect(RegisterRequestSchema.safeParse({ ...VALID_REGISTER_BASE, name: 'MyBot' }).success).toBe(false);
  });

  it('rejects names with spaces', () => {
    expect(RegisterRequestSchema.safeParse({ ...VALID_REGISTER_BASE, name: 'my bot' }).success).toBe(false);
  });

  it('rejects names longer than 32 chars', () => {
    expect(RegisterRequestSchema.safeParse({ ...VALID_REGISTER_BASE, name: 'a' + 'b'.repeat(32) }).success).toBe(false);
  });
});

describe('DispatchRequestSchema.persona_name uses PersonaNameSchema', () => {
  it('accepts valid persona names', () => {
    expect(DispatchRequestSchema.safeParse({ ...VALID_DISPATCH_BASE, persona_name: 'tinkerer' }).success).toBe(true);
    expect(DispatchRequestSchema.safeParse({ ...VALID_DISPATCH_BASE, persona_name: 'my-custom-bot' }).success).toBe(true);
    expect(DispatchRequestSchema.safeParse({ ...VALID_DISPATCH_BASE, persona_name: 'bot_v2' }).success).toBe(true);
  });

  it('rejects shell-injection persona name $(echo pwned)', () => {
    const result = DispatchRequestSchema.safeParse({
      ...VALID_DISPATCH_BASE,
      persona_name: '$(echo pwned)',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('^[a-z][a-z0-9_-]{0,31}$');
    }
  });

  it('rejects empty string', () => {
    expect(DispatchRequestSchema.safeParse({ ...VALID_DISPATCH_BASE, persona_name: '' }).success).toBe(false);
  });

  it('rejects names with shell metacharacters', () => {
    const bad = ['$(rm)', '`cmd`', 'a;b', 'a|b', 'a&b'];
    for (const name of bad) {
      expect(
        DispatchRequestSchema.safeParse({ ...VALID_DISPATCH_BASE, persona_name: name }).success,
        `should reject "${name}"`,
      ).toBe(false);
    }
  });

  it('rejects names with uppercase letters', () => {
    expect(DispatchRequestSchema.safeParse({ ...VALID_DISPATCH_BASE, persona_name: 'BadName' }).success).toBe(false);
  });
});
