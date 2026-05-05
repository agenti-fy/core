import { z, ZodError } from 'zod';

/**
 * Strict env-flag → boolean. `z.coerce.boolean()` uses `Boolean(s)` which
 * treats `"0"`, `"false"`, and any other non-empty string as truthy — so
 * `FLAG=0` would be parsed as **true**, the opposite of what every operator
 * expects. This transformer treats only canonical truthy strings as true.
 */
export const boolFlag = (defaultValue = false) =>
  z
    .union([z.string(), z.boolean(), z.undefined()])
    .transform((v) => {
      if (v === undefined) return defaultValue;
      if (typeof v === 'boolean') return v;
      const s = v.trim().toLowerCase();
      if (s === '' || s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
      if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
      return defaultValue;
    });

/**
 * GitHub App private keys are PEM. When supplied via env they're often encoded
 * with literal "\n" sequences — restore real newlines so Octokit accepts them.
 */
export function normalizePrivateKey(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

/**
 * If `err` is a Zod parse error, write each issue (path + message) to stderr
 * as a structured operator-readable list. Falls back to `console.error('fatal:',
 * err)` for anything else. Returns true if the error was a ZodError so the
 * caller can suppress its own generic logging.
 */
export function reportConfigError(err: unknown, label = 'config'): boolean {
  if (err instanceof ZodError) {
     
    console.error(`${label}: invalid configuration`);
    for (const issue of err.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
       
      console.error(`  - ${path}: ${issue.message}`);
    }
    return true;
  }
  return false;
}
