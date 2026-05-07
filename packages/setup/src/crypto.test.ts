import { describe, it, expect } from 'vitest';
import { encryptValue, decryptValue, DecryptError, EncryptedValueSchema } from './crypto.js';

// ---------------------------------------------------------------------------
// EncryptedValueSchema
// ---------------------------------------------------------------------------

describe('EncryptedValueSchema', () => {
  it('accepts a well-formed encrypted value', () => {
    const val = encryptValue('hello', 'passphrase');
    expect(() => EncryptedValueSchema.parse(val)).not.toThrow();
  });

  it('rejects a value with the wrong version number', () => {
    const val = { ...encryptValue('hello', 'pw'), version: 1 };
    expect(() => EncryptedValueSchema.parse(val)).toThrow();
  });

  it('rejects a value missing a required field', () => {
    const { ciphertext: _drop, ...partial } = encryptValue('hello', 'pw');
    expect(() => EncryptedValueSchema.parse(partial)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('encryptValue / decryptValue — round-trip', () => {
  it('round-trips a simple string', () => {
    const plaintext = 'hello';
    const encrypted = encryptValue(plaintext, 'pw');
    expect(decryptValue(encrypted, 'pw')).toBe(plaintext);
  });

  it('round-trips a multi-byte PEM string byte-identically', () => {
    // A realistic RSA private key PEM excerpt — exercises UTF-8 faithfulness,
    // no truncation, and no trailing-newline drops.
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4PAtEsHAP19A0R4OREO8JZDJ8WI',
      'vy5BFG6vHKwGX8OdJJTZpHFrGqAbMfBzOxiR7Rcpqd9jUPF6FxBaOO5oX3CcXQC',
      'GtqHqLMFCPRpB7nG1Sct9jcbBZLFMR4kJmOoTtDi7LKDH5AhJvGCo7Xf0R5cBpZ',
      'v6HE6pE3LxOqCGAnIj3Xhp3Y8RAnhE3eFr9D+IUlqLGnTq+yPqoD1RfTHNIz9QaZ',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==',
      '-----END RSA PRIVATE KEY-----',
      '', // trailing newline preserved
    ].join('\n');

    const encrypted = encryptValue(pem, 'correct-horse-battery-staple');
    const decrypted = decryptValue(encrypted, 'correct-horse-battery-staple');
    expect(decrypted).toBe(pem);
    expect(decrypted.length).toBe(pem.length);
  });

  it('round-trips a string with non-ASCII characters', () => {
    const unicode = 'ñoño café naïve résumé 日本語 🔑';
    const encrypted = encryptValue(unicode, 'pw');
    expect(decryptValue(encrypted, 'pw')).toBe(unicode);
  });

  it('produces version 2 in the output', () => {
    const encrypted = encryptValue('test', 'pw');
    expect(encrypted.version).toBe(2);
  });

  it('all base64 fields are non-empty strings', () => {
    const encrypted = encryptValue('test', 'pw');
    expect(encrypted.iv.length).toBeGreaterThan(0);
    expect(encrypted.salt.length).toBeGreaterThan(0);
    expect(encrypted.tag.length).toBeGreaterThan(0);
    expect(encrypted.ciphertext.length).toBeGreaterThan(0);
  });

  it('decodes to the correct raw byte sizes', () => {
    const encrypted = encryptValue('test', 'pw');
    // iv: 12 bytes → base64 length = ceil(12 / 3) * 4 = 16 chars
    expect(Buffer.from(encrypted.iv, 'base64').byteLength).toBe(12);
    // salt: 32 bytes → base64 length = ceil(32 / 3) * 4 = 44 chars
    expect(Buffer.from(encrypted.salt, 'base64').byteLength).toBe(32);
    // tag: 16 bytes → base64 length = 24 chars
    expect(Buffer.from(encrypted.tag, 'base64').byteLength).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// Wrong passphrase
// ---------------------------------------------------------------------------

describe('decryptValue — wrong passphrase', () => {
  it('throws DecryptError when the passphrase is wrong', () => {
    const encrypted = encryptValue('secret', 'correct-pw');
    expect(() => decryptValue(encrypted, 'wrong-pw')).toThrow(DecryptError);
  });

  it('DecryptError.name is "DecryptError"', () => {
    const encrypted = encryptValue('secret', 'pw');
    let caught: unknown;
    try {
      decryptValue(encrypted, 'bad');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DecryptError);
    expect((caught as DecryptError).name).toBe('DecryptError');
  });

  it('does not return partial plaintext on wrong passphrase', () => {
    const plaintext = 'super secret value';
    const encrypted = encryptValue(plaintext, 'correct');
    let result: string | undefined;
    try {
      result = decryptValue(encrypted, 'wrong');
    } catch {
      // expected
    }
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tampered ciphertext
// ---------------------------------------------------------------------------

describe('decryptValue — tampered ciphertext', () => {
  it('throws DecryptError when one base64 char in ciphertext is flipped', () => {
    const encrypted = encryptValue('attack at dawn', 'pw');

    // Flip the first character of the base64-encoded ciphertext.
    // Any modification to the ciphertext bytes breaks the AES-GCM tag.
    const tampered = { ...encrypted };
    const chars = [...tampered.ciphertext];
    // Change 'A' → 'B', 'B' → 'C', or fallback to 'A' for any other char
    const original = chars[0] ?? 'A';
    chars[0] = original === 'A' ? 'B' : original === 'B' ? 'C' : 'A';
    tampered.ciphertext = chars.join('');

    expect(() => decryptValue(tampered, 'pw')).toThrow(DecryptError);
  });

  it('throws DecryptError when the tag is altered', () => {
    const encrypted = encryptValue('sensitive data', 'pw');
    const tampered = { ...encrypted };

    // Flip the first char of the tag
    const tagChars = [...tampered.tag];
    const original = tagChars[0] ?? 'A';
    tagChars[0] = original === 'A' ? 'B' : 'A';
    tampered.tag = tagChars.join('');

    expect(() => decryptValue(tampered, 'pw')).toThrow(DecryptError);
  });

  it('throws DecryptError when extra bytes are appended to ciphertext', () => {
    const encrypted = encryptValue('data', 'pw');
    // Operate at buffer level — Buffer.from is lenient with trailing base64
    // padding, so string concatenation doesn't reliably change the decoded
    // bytes.  Instead, decode → append a zero byte → re-encode.
    const buf = Buffer.from(encrypted.ciphertext, 'base64');
    const tampered = {
      ...encrypted,
      ciphertext: Buffer.concat([buf, Buffer.alloc(1)]).toString('base64'),
    };
    expect(() => decryptValue(tampered, 'pw')).toThrow(DecryptError);
  });
});

// ---------------------------------------------------------------------------
// Salt non-reuse
// ---------------------------------------------------------------------------

describe('encryptValue — salt non-reuse', () => {
  it('two calls with the same arguments produce different salts', () => {
    const a = encryptValue('x', 'pw');
    const b = encryptValue('x', 'pw');
    expect(a.salt).not.toBe(b.salt);
  });

  it('two calls with the same arguments produce different IVs', () => {
    const a = encryptValue('x', 'pw');
    const b = encryptValue('x', 'pw');
    expect(a.iv).not.toBe(b.iv);
  });

  it('two calls with the same arguments produce different ciphertexts', () => {
    const a = encryptValue('x', 'pw');
    const b = encryptValue('x', 'pw');
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('all three pairs differ across many calls (statistical sanity)', () => {
    const results = Array.from({ length: 5 }, () => encryptValue('same', 'pw'));
    const salts = new Set(results.map((r) => r.salt));
    const ivs = new Set(results.map((r) => r.iv));
    expect(salts.size).toBe(5);
    expect(ivs.size).toBe(5);
  });
});
