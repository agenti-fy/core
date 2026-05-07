/**
 * crypto.ts — AES-256-GCM + scrypt encrypt/decrypt primitives.
 *
 * Implements the encrypt-at-rest contract from ADR-001:
 *   docs/adr/001-pem-at-rest-mitigation.md
 *
 * On-disk shape (EncryptedValue):
 *   {
 *     version:    2          (literal — schema version sentinel)
 *     iv:         <base64>   12-byte AES-GCM nonce
 *     salt:       <base64>   32-byte scrypt salt (fresh per call)
 *     tag:        <base64>   16-byte AES-GCM authentication tag
 *     ciphertext: <base64>   encrypted payload bytes
 *   }
 *
 * Design notes:
 *  - scrypt parameters (N=2^14, r=8, p=1) are the standard "interactive"
 *    profile from RFC 7914, completing in <100 ms on commodity hardware.
 *  - A fresh 32-byte salt per encryptValue call eliminates any risk of
 *    cross-field nonce reuse even when the same passphrase is used for
 *    multiple fields.
 *  - scryptSync is used deliberately — this module is called from a
 *    one-time bootstrap CLI, not from a server request loop. The sync
 *    form simplifies testing.
 *  - No new npm dependencies: node:crypto ships with Node 22.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for an encrypted value stored in the wizard's state file.
 *
 * All byte fields are base64-encoded strings so the state file remains
 * human-readable JSON (structure is legible; only leaf values are opaque).
 *
 * Sizes per ADR-001 §"Concrete contract":
 *  - iv:         12 bytes  (AES-GCM nonce)
 *  - salt:       32 bytes  (scrypt salt)
 *  - tag:        16 bytes  (AES-GCM authentication tag)
 *  - ciphertext: variable  (same byte-length as plaintext)
 */
export const EncryptedValueSchema = z.object({
  version: z.literal(2),
  iv: z.string(),
  salt: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});

/**
 * The on-disk shape of an encrypted sensitive field.
 *
 * This type represents encrypted bytes — NOT the plaintext. Keep them clearly
 * separate in the type system: plaintext PEMs/secrets live in `WizardState`;
 * `EncryptedValue` lives only in the persisted state file and in-transit
 * between loadState/saveState and the encrypt/decrypt helpers.
 */
export type EncryptedValue = z.infer<typeof EncryptedValueSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link decryptValue} when decryption fails — either because the
 * passphrase is wrong or because the ciphertext has been tampered with.
 *
 * AES-GCM authentication guarantees that a bad tag (from a wrong key or
 * flipped ciphertext bits) is caught before any plaintext is returned.
 * Both cases surface here as `DecryptError` so callers have a single,
 * named error class to catch.
 */
export class DecryptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DecryptError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** scrypt key-derivation parameters per ADR-001 §"Concrete contract". */
const SCRYPT_PARAMS = { N: 2 ** 14, r: 8, p: 1 } as const;

/** Derived key length in bytes (256-bit key for AES-256). */
const KEY_LENGTH = 32;

/** AES-GCM IV size in bytes. */
const IV_LENGTH = 12;

/** scrypt salt size in bytes. */
const SALT_LENGTH = 32;

/**
 * Derive a 32-byte AES key from `passphrase` + `salt` using scrypt.
 *
 * Kept private — callers deal only with base64-encoded EncryptedValue objects.
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, SCRYPT_PARAMS);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt `plaintext` with AES-256-GCM using a key derived from `passphrase`.
 *
 * Each call generates a fresh 32-byte salt and 12-byte IV, so two calls with
 * identical arguments produce different ciphertext — no nonce reuse.
 *
 * @param plaintext  - The UTF-8 string to encrypt (e.g. a PEM private key).
 * @param passphrase - The operator-supplied passphrase (min-length is the
 *                     caller's responsibility; this module accepts any string).
 * @returns An {@link EncryptedValue} suitable for JSON serialization.
 */
export function encryptValue(plaintext: string, passphrase: string): EncryptedValue {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 2,
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

/**
 * Decrypt an {@link EncryptedValue} using `passphrase`.
 *
 * The AES-GCM authentication tag is verified before any plaintext is returned.
 * A wrong passphrase (which derives a different key) causes an authentication-
 * tag mismatch, which surfaces as {@link DecryptError} — no partial plaintext
 * is ever returned.
 *
 * @param value      - The encrypted value to decrypt.
 * @param passphrase - The operator-supplied passphrase used during encryption.
 * @returns The original UTF-8 plaintext string.
 * @throws {@link DecryptError} on authentication failure (wrong passphrase or
 *         tampered ciphertext).
 */
export function decryptValue(value: EncryptedValue, passphrase: string): string {
  const salt = Buffer.from(value.salt, 'base64');
  const iv = Buffer.from(value.iv, 'base64');
  const tag = Buffer.from(value.tag, 'base64');
  const ciphertext = Buffer.from(value.ciphertext, 'base64');

  const key = deriveKey(passphrase, salt);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    throw new DecryptError(
      'Decryption failed — wrong passphrase or tampered ciphertext.',
      { cause: err },
    );
  }
}
