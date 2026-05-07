/**
 * dotenv.ts — minimal .env file parser shared by env-renderer.test.ts and
 * the `verify` subcommand in driver/finalize.ts.
 *
 * Handles the specific quoting style produced by env-renderer.ts:
 *   - Single-quoted multi-line blocks (PEM keys) with POSIX '\'' escape.
 *   - Double-quoted single-line values with basic \" and \\ escaping.
 *   - Bare (unquoted) values.
 *   - Comment lines (starting with #) and blank lines are skipped.
 *
 * No runtime dependencies — intentionally zero-dep per the repo style guide.
 */

/**
 * Parse a `.env` file string into a key→value record.
 *
 * All values are returned as strings with their quoting removed.  Multi-line
 * PEM values are returned with real newlines (not `\n` escape sequences).
 *
 * @param content The raw content of the `.env` file.
 * @returns A record mapping each variable name to its unquoted value.
 */
export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  let i = 0;
  const lines = content.split('\n');

  while (i < lines.length) {
    const rawLine = lines[i];
    if (rawLine === undefined) {
      i++;
      continue;
    }
    const trimmed = rawLine.trim();
    // Skip blank lines and comment lines.
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      i++;
      continue;
    }

    const key = trimmed.slice(0, eqIdx).trim();
    const rest = trimmed.slice(eqIdx + 1);

    // Single-quoted multi-line block: accumulate until the closing unescaped '.
    if (rest.startsWith("'")) {
      // Walk forward to find the matching closing single-quote.
      // Escaped single-quotes appear as '\'' (POSIX quoting).
      const valueParts: string[] = [];
      let chunk = rest.slice(1); // strip opening '

      for (;;) {
        // Does this chunk contain a closing ' not preceded by \'\ ?
        const closeIdx = chunk.indexOf("'");
        if (closeIdx !== -1) {
          // Check for POSIX-escaped embedded quote: '\''
          // quoteValue encodes each ' as '\'' (close-quote, \-escaped-quote, reopen-quote).
          // After the closing ' at closeIdx, the POSIX escape is \'' (three chars).
          valueParts.push(chunk.slice(0, closeIdx));
          const after = chunk.slice(closeIdx + 1);
          if (after.startsWith("\\''")) {
            // POSIX escaped '\'' → literal ' then reopen single-quoting.
            valueParts.push("'");
            chunk = after.slice(3); // skip \'' (escape-char, literal-quote, reopen-quote)
          } else {
            // Real closing quote — done.
            break;
          }
        } else {
          // No closing quote on this line — consume the newline and advance.
          valueParts.push(chunk);
          valueParts.push('\n');
          i++;
          const nextLine = lines[i];
          chunk = nextLine ?? '';
        }
      }

      result[key] = valueParts.join('');
      i++;
      continue;
    }

    // Double-quoted value: single-line only, handle \" and \\.
    if (rest.startsWith('"')) {
      let value = '';
      let j = 1;
      while (j < rest.length) {
        const ch = rest[j];
        if (ch === '\\' && j + 1 < rest.length) {
          const next = rest[j + 1];
          value += next === '"' ? '"' : next === '\\' ? '\\' : `\\${next}`;
          j += 2;
        } else if (ch === '"') {
          break;
        } else {
          value += ch;
          j++;
        }
      }
      result[key] = value;
      i++;
      continue;
    }

    // Bare value.
    result[key] = rest.trim();
    i++;
  }

  return result;
}
