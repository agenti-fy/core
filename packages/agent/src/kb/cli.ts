/**
 * agentify-kb CLI — the only supported write path for the knowledge base.
 *
 * Commands:
 *   append <scope>   Append a new entry to the KB page ('global' | 'persona').
 *   read   <scope>   Print the KB page to stdout.
 *   list             Print names of all KB pages found in KB_CLONE_DIR.
 *
 * Environment variables resolved from `env` (process.env when run directly):
 *   KB_CLONE_DIR        Per-job wiki worktree. Missing → exit 0 (KB unavailable).
 *   AGENTIFY_PERSONA    Persona name, e.g. 'tinkerer'.
 *   AGENTIFY_JOB_ID     Job ID included in commit message + entry source link.
 *   KB_GLOBAL_PAGE      Global page stem without .md, e.g. 'KB-Global'. Default: 'KB-Global'.
 *   KB_PAGE_PREFIX      Persona page prefix, e.g. 'KB-'. Default: 'KB-'.
 *   KB_WRITE_RETRY_MAX  Max push-retry attempts on non-fast-forward. Default: 3.
 *   KB_ENTRY_MAX_BYTES  Max entry body in bytes. Default: 1024.
 *
 * Exit codes:
 *   0  Success, or KB unavailable (not an error — skill continues without KB).
 *   1  Unexpected git or I/O failure.
 *   2  Validation failure (empty body, body too large, bad scope / conflicting flags).
 *   3  Page file not found (wiki not bootstrapped).
 *   4  Conflict retries exhausted (push permanently rejected).
 *
 * On success, `append` writes a JSON line to stdout:
 *   {"page":"KB-Tinkerer","scope":"persona","bytes":<n>,"sha":"<commit-sha>","conflicts":<n>}
 * Claude folds this into the `kb_writes` artifact; the skill runner records metrics.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { kbGitIdentity, kbPageFilename, kbPersonaSignature } from './pages.js';
import { validateKbPageName } from './page-name.js';

const exec = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Subset of process.env the CLI reads. Passed as a parameter so tests can
 * inject a custom env without spawning a child process.
 */
export type CliEnv = Record<string, string | undefined>;

// ── Git helper ────────────────────────────────────────────────────────────────

/** Run a git command in `cwd`, scrubbing auth tokens from any error message. */
async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const safe = (e.stderr ?? e.message)
      .replace(/Basic [A-Za-z0-9+/=]+/g, 'Basic ***')
      .replace(/x-access-token:[^@\s/]+/g, 'x-access-token:***');
    throw new Error(`git ${args.join(' ')} failed: ${safe}`, { cause: err });
  }
}

// ── Retry backoff ─────────────────────────────────────────────────────────────

/**
 * Exponential pause between push-retry attempts.
 * Schedule: 200 ms → 600 ms → 1 400 ms (last value repeated for any further attempts).
 */
const RETRY_PAUSES_MS = [200, 600, 1400];

function pause(attempt: number): Promise<void> {
  const ms = RETRY_PAUSES_MS[attempt] ?? RETRY_PAUSES_MS[RETRY_PAUSES_MS.length - 1] ?? 1400;
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ── Date helper ───────────────────────────────────────────────────────────────

/** Returns today's UTC date as 'YYYY-MM-DD'. */
function utcDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Entry formatter ───────────────────────────────────────────────────────────

interface FormatEntryOpts {
  body: string;
  persona: string;
  jobId: string;
  /** '#<n>' for issues/PRs, or null when no source was specified. */
  source: string | null;
}

/**
 * Build a formatted KB entry block (without a leading `---` separator).
 *
 * The first non-empty line of `body` becomes the heading title; remaining
 * lines form the body paragraph below the heading.
 *
 * Output shape:
 *   ## YYYY-MM-DD — <title> (<jobId>[, <source>])
 *
 *   <remaining body>
 *
 *   — <signature>
 */
function formatEntry({ body, persona, jobId, source }: FormatEntryOpts): string {
  const date = utcDateString();
  const lines = body.split('\n');

  // First non-empty line → heading title; rest → body paragraph.
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  const title = firstIdx >= 0 ? (lines[firstIdx] ?? '').trim() : '(no title)';
  const rest = (firstIdx >= 0 ? lines.slice(firstIdx + 1) : []).join('\n').trimStart();

  // Refs in the heading parenthetical: jobId always present; source if provided.
  const refs = [source, jobId].filter((s): s is string => s != null && s.length > 0).join(', ');
  const heading = `## ${date} — ${title} (${refs})`;

  const sig = kbPersonaSignature(persona);

  const parts: string[] = [heading, ''];
  if (rest.length > 0) {
    parts.push(rest, '');
  }
  parts.push(`— ${sig}`);

  return parts.join('\n');
}

// ── Page splicer ──────────────────────────────────────────────────────────────

/**
 * Insert `entryBlock` (a formatted entry WITHOUT a leading `---` separator)
 * after the first horizontal-rule separator in `page`, maintaining newest-first
 * ordering.
 *
 * Page shape expected from bootstrap (#252):
 *   # KB: <Title>
 *
 *   > description
 *
 *   ---
 *
 * After the first splice:
 *   # KB: <Title>
 *
 *   > description
 *
 *   ---
 *
 *   ## <entry-heading>
 *
 *   <body>
 *
 *   — <signature>
 *
 * After a subsequent splice (newest-first):
 *   ---
 *
 *   ## <newer-entry>
 *   ...
 *
 *   ---
 *
 *   ## <older-entry>
 *   ...
 *
 * If the page has no `---` separator (malformed page), the entry is appended
 * with a separator added — best-effort, leaves the file usable.
 */
function spliceEntry(page: string, entryBlock: string): string {
  const sepRe = /^---$/m;
  const match = sepRe.exec(page);

  if (!match) {
    // Fallback for malformed pages without a separator.
    return `${page.trimEnd()}\n\n---\n\n${entryBlock}\n`;
  }

  const sepEnd = match.index + 3; // index of character right after '---'
  const afterSep = page.slice(sepEnd).trimStart();

  if (afterSep.length === 0) {
    // Bootstrap page: no existing entries — append directly after header ---
    return `${page.slice(0, sepEnd)}\n\n${entryBlock}\n`;
  }

  // Existing entries present — new entry goes first, old content separated by ---
  return `${page.slice(0, sepEnd)}\n\n${entryBlock}\n\n---\n\n${afterSep}`;
}

// ── stdin reader ──────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ── Scope guard ───────────────────────────────────────────────────────────────

/** Parses and validates a scope argument; exits 2 on bad input. */
function parseScope(raw: string): 'global' | 'persona' {
  if (raw === 'global' || raw === 'persona') return raw;
  process.stderr.write(`agentify-kb: unknown scope '${raw}' — expected global|persona\n`);
  process.exit(2);
}

// ── push-conflict detector ────────────────────────────────────────────────────

function isPushConflict(msg: string): boolean {
  return (
    msg.includes('non-fast-forward') ||
    msg.includes('rejected') ||
    msg.includes('stale info') ||
    msg.includes('fetch first')
  );
}

// ── subcommand: append ────────────────────────────────────────────────────────

interface AppendOptions {
  scope: 'global' | 'persona';
  fromIssue?: number | undefined;
  fromPr?: number | undefined;
  /** Override the AGENTIFY_PERSONA env var (tests only). */
  persona?: string | undefined;
  /** Read body from this file path instead of stdin. */
  file?: string | undefined;
}

async function cmdAppend(opts: AppendOptions, env: CliEnv): Promise<void> {
  const cloneDir = env['KB_CLONE_DIR'];
  if (!cloneDir) {
    process.stderr.write('agentify-kb: KB unavailable (KB_CLONE_DIR not set)\n');
    process.exit(0);
  }

  const persona = opts.persona ?? env['AGENTIFY_PERSONA'] ?? '';
  const jobId = env['AGENTIFY_JOB_ID'] ?? 'unknown';
  const globalPage = env['KB_GLOBAL_PAGE'] ?? 'KB-Global';
  const pagePrefix = env['KB_PAGE_PREFIX'] ?? 'KB-';
  const retryMax = Math.max(1, parseInt(env['KB_WRITE_RETRY_MAX'] ?? '3', 10));
  const entryMaxBytes = Math.max(1, parseInt(env['KB_ENTRY_MAX_BYTES'] ?? '1024', 10));

  // ── 0. Validate resolved page name — trust boundary ────────────────────────
  // This is the agent-trust boundary: validate the resolved page name stem
  // BEFORE any fs.* or git operation. Both the --persona argv override and the
  // AGENTIFY_PERSONA env flow through this check via `persona` above.
  // See packages/agent/src/kb/page-name.ts for the full security rationale.
  {
    const stem = kbPageFilename(opts.scope, persona, globalPage, pagePrefix).replace(/\.md$/, '');
    try {
      validateKbPageName(stem);
    } catch (err) {
      process.stderr.write(`agentify-kb: ${(err as Error).message}\n`);
      process.exit(2);
    }
  }

  // ── 1. Read body from file or stdin ────────────────────────────────────────
  let body = opts.file != null ? await readFile(opts.file, 'utf8') : await readStdin();
  body = body.trimEnd();

  // ── 2. Validate body ───────────────────────────────────────────────────────
  if (!body.trim()) {
    process.stderr.write('agentify-kb: empty entry\n');
    process.exit(2);
  }
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > entryMaxBytes) {
    process.stderr.write(`agentify-kb: entry exceeds ${entryMaxBytes} bytes\n`);
    process.exit(2);
  }

  // ── 3. Resolve target file ─────────────────────────────────────────────────
  const filename = kbPageFilename(opts.scope, persona, globalPage, pagePrefix);
  const filePath = join(cloneDir, filename);

  try {
    await stat(filePath);
  } catch {
    process.stderr.write(`agentify-kb: wiki not initialized (${filename} not found)\n`);
    process.exit(3);
  }

  // ── 4. Build formatted entry ───────────────────────────────────────────────
  let source: string | null = null;
  if (opts.fromIssue != null) {
    source = `#${opts.fromIssue}`;
  } else if (opts.fromPr != null) {
    source = `#${opts.fromPr}`;
  }

  const entryBlock = formatEntry({ body, persona, jobId, source });

  // ── 5. Write + commit ──────────────────────────────────────────────────────
  const sourceStr = source != null ? ` from ${source}` : '';
  const commitMsg = `kb: append ${opts.scope}${sourceStr} (${jobId})`;
  const identity = kbGitIdentity(persona);

  const pageContent = await readFile(filePath, 'utf8');
  await writeFile(filePath, spliceEntry(pageContent, entryBlock), 'utf8');

  await git(cloneDir, ['add', '--', filename]);

  try {
    await git(cloneDir, [
      '-c', `user.name=${identity.name}`,
      '-c', `user.email=${identity.email}`,
      'commit', '-m', commitMsg,
    ]);
  } catch (err) {
    process.stderr.write(`agentify-kb: git commit failed: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // ── 6. Push with retry-on-conflict ─────────────────────────────────────────
  let conflictCount = 0;
  let sha = '';
  let finalConflictErr: Error | null = null;

  for (let attempt = 0; attempt < retryMax; attempt++) {
    try {
      await git(cloneDir, ['push', '--force-with-lease']);
      const { stdout } = await git(cloneDir, ['rev-parse', 'HEAD']);
      sha = stdout.trim();
      finalConflictErr = null;
      break;
    } catch (pushErr) {
      const msg = (pushErr as Error).message;

      if (!isPushConflict(msg)) {
        // Non-conflict git failure — surface immediately.
        process.stderr.write(`agentify-kb: push failed: ${msg}\n`);
        process.exit(1);
      }

      finalConflictErr = pushErr as Error;
      conflictCount++;

      if (attempt < retryMax - 1) {
        await pause(attempt);
        try {
          await git(cloneDir, ['pull', '--rebase']);
        } catch (rebaseErr) {
          process.stderr.write(
            `agentify-kb: rebase failed: ${(rebaseErr as Error).message}\n`,
          );
          process.exit(1);
        }
      }
    }
  }

  if (finalConflictErr != null) {
    process.stderr.write('agentify-kb: conflict retry exhausted\n');
    process.exit(4);
  }

  // ── 7. Output result ───────────────────────────────────────────────────────
  const result = {
    page: filename.replace(/\.md$/, ''),
    scope: opts.scope,
    bytes: bodyBytes,
    sha,
    conflicts: conflictCount,
  };
  process.stdout.write(JSON.stringify(result) + '\n');
}

// ── subcommand: read ──────────────────────────────────────────────────────────

async function cmdRead(scope: 'global' | 'persona', env: CliEnv): Promise<void> {
  const cloneDir = env['KB_CLONE_DIR'];
  if (!cloneDir) {
    process.stderr.write('agentify-kb: KB unavailable (KB_CLONE_DIR not set)\n');
    process.exit(0);
  }

  const persona = env['AGENTIFY_PERSONA'] ?? '';
  const globalPage = env['KB_GLOBAL_PAGE'] ?? 'KB-Global';
  const pagePrefix = env['KB_PAGE_PREFIX'] ?? 'KB-';
  const filename = kbPageFilename(scope, persona, globalPage, pagePrefix);

  // Validate the resolved page name stem before any fs.* operation.
  try {
    validateKbPageName(filename.replace(/\.md$/, ''));
  } catch (err) {
    process.stderr.write(`agentify-kb: ${(err as Error).message}\n`);
    process.exit(2);
  }

  const filePath = join(cloneDir, filename);

  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    process.stderr.write(`agentify-kb: wiki not initialized (${filename} not found)\n`);
    process.exit(3);
  }

  process.stdout.write(content);
}

// ── subcommand: list ──────────────────────────────────────────────────────────

async function cmdList(env: CliEnv): Promise<void> {
  const cloneDir = env['KB_CLONE_DIR'];
  if (!cloneDir) {
    process.stderr.write('agentify-kb: KB unavailable (KB_CLONE_DIR not set)\n');
    process.exit(0);
  }

  let entries: string[];
  try {
    entries = await readdir(cloneDir);
  } catch {
    process.stderr.write('agentify-kb: failed to read KB directory\n');
    process.exit(1);
  }

  const pages = entries.filter((e) => e.endsWith('.md')).sort();
  if (pages.length > 0) {
    process.stdout.write(pages.join('\n') + '\n');
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

/**
 * CLI entry point. Accepts `argv` (process.argv-style) and `env`
 * (process.env-style) so tests can inject both without spawning a subprocess.
 */
export async function main(argv: string[], env: CliEnv): Promise<void> {
  const args = argv.slice(2); // strip node + script path
  const cmd = args[0];

  // ── Startup: validate KB_GLOBAL_PAGE env value ────────────────────────────
  // The agent config already constrains KB_GLOBAL_PAGE (no slashes, no .md
  // suffix) but the CLI re-validates defense-in-depth so a misconfigured env
  // var fails fast with a clear message before any fs.* or git operation.
  // We validate the effective value (env override or the hardcoded default
  // 'KB-Global') so operators see an error regardless of which code path runs.
  const effectiveGlobalPage = env['KB_GLOBAL_PAGE'] ?? 'KB-Global';
  try {
    validateKbPageName(effectiveGlobalPage);
  } catch (err) {
    process.stderr.write(`agentify-kb: ${(err as Error).message}\n`);
    process.exit(2);
  }

  if (cmd == null || cmd === '--help' || cmd === '-h') {
    process.stdout.write('Usage: agentify-kb <append <scope>|read <scope>|list>\n');
    return;
  }

  switch (cmd) {
    case 'append': {
      const rawScope = args[1];
      if (!rawScope) {
        process.stderr.write('agentify-kb append: missing <scope>\n');
        process.exit(2);
      }
      const scope = parseScope(rawScope);
      const opts: AppendOptions = { scope };

      for (let i = 2; i < args.length; i++) {
        const flag = args[i];
        const next = args[i + 1];
        if (flag === '--from-issue' && next != null) {
          opts.fromIssue = parseInt(next, 10);
          i++;
        } else if (flag === '--from-pr' && next != null) {
          opts.fromPr = parseInt(next, 10);
          i++;
        } else if ((flag === '-f' || flag === '--file') && next != null) {
          opts.file = next;
          i++;
        } else if (flag === '--persona' && next != null) {
          opts.persona = next;
          i++;
        }
      }

      if (opts.fromIssue != null && opts.fromPr != null) {
        process.stderr.write(
          'agentify-kb: --from-issue and --from-pr are mutually exclusive\n',
        );
        process.exit(2);
      }

      await cmdAppend(opts, env);
      break;
    }

    case 'read': {
      const rawScope = args[1];
      if (!rawScope) {
        process.stderr.write('agentify-kb read: missing <scope>\n');
        process.exit(2);
      }
      await cmdRead(parseScope(rawScope), env);
      break;
    }

    case 'list': {
      await cmdList(env);
      break;
    }

    default: {
      process.stderr.write(`agentify-kb: unknown command '${cmd}'\n`);
      process.exit(2);
    }
  }
}

// ── Direct invocation ─────────────────────────────────────────────────────────

// Detect whether this module is the entry point (not imported as a library).
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main(process.argv, process.env).catch((err: unknown) => {
    process.stderr.write(
      `agentify-kb: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
