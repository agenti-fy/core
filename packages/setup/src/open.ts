/**
 * open.ts — cross-platform browser launcher for the setup wizard.
 *
 * Launches a URL in the system's default browser without any npm dependency.
 * Gracefully degrades on headless hosts by printing the URL for manual opening.
 *
 * Design constraints:
 *  - Uses child_process.spawn with detached:true + stdio:'ignore' + unref() so
 *    the wizard process does NOT wait for the browser to close.
 *  - URL is passed as a discrete argv element, never shell-interpolated, to
 *    prevent command injection from a malicious-looking URL.
 *  - WSL is detected by reading /proc/version at call time (not module load time)
 *    so it can be tested via vi.mock('node:fs').
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ── Public types ────────────────────────────────────────────────────────────

export interface OpenResult {
  /** true if spawn was attempted without an immediate error; false on fallback. */
  launched: boolean;
}

export interface OpenOptions {
  /**
   * Where to write the "Open this URL manually:" fallback message.
   * Defaults to process.stdout.
   */
  stdout?: NodeJS.WriteStream;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Resolved launch command — binary and argument list.
 * Exported so unit tests can cover the pure platform-dispatch logic
 * without mocking child_process.
 */
export interface LaunchCommand {
  bin: string;
  args: readonly string[];
}

/**
 * Pure function: choose the right binary and args for the given platform.
 *
 * @param url          - The URL to open (used as a discrete argv element).
 * @param platform     - Value of process.platform (injectable for testing).
 * @param wslContent   - Contents of /proc/version if already read; pass
 *                       undefined to skip WSL detection (non-linux platforms).
 */
export function resolveCommand(
  url: string,
  platform: NodeJS.Platform,
  wslContent?: string,
): LaunchCommand {
  if (platform === 'darwin') {
    return { bin: 'open', args: [url] };
  }

  if (platform === 'win32') {
    // Empty-string title arg avoids the path-with-spaces gotcha on Windows.
    return { bin: 'cmd', args: ['/c', 'start', '', url] };
  }

  // linux / other — check for WSL first
  const isWsl =
    wslContent !== undefined && /microsoft/i.test(wslContent);
  if (isWsl) {
    return { bin: 'cmd.exe', args: ['/c', 'start', '', url] };
  }

  return { bin: 'xdg-open', args: [url] };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Launch `url` in the system default browser, then immediately return.
 *
 * The child process is detached and unref()-ed so the calling process can
 * exit without waiting for the browser to close.
 *
 * On linux (non-WSL), if `xdg-open` is missing (ENOENT), the function
 * prints a bold "Open this URL manually:" line to stdout and resolves with
 * `{ launched: false }`. All other spawn errors also trigger the fallback.
 */
export async function openInBrowser(
  url: string,
  opts?: OpenOptions,
): Promise<OpenResult> {
  const out: NodeJS.WriteStream = opts?.stdout ?? process.stdout;

  // Read /proc/version once for WSL detection on linux.
  let wslContent: string | undefined;
  if (process.platform === 'linux') {
    try {
      wslContent = readFileSync('/proc/version', 'utf8');
    } catch {
      // Not WSL (or /proc not available) — proceed with xdg-open.
    }
  }

  const { bin, args } = resolveCommand(url, process.platform, wslContent);

  return new Promise<OpenResult>((resolve) => {
    let resolved = false;

    const child = spawn(bin, Array.from(args), {
      detached: true,
      stdio: 'ignore',
    });

    child.on('error', () => {
      if (!resolved) {
        resolved = true;
        // Bold ANSI escape so the URL stands out on a dark terminal.
        out.write(`\x1b[1mOpen this URL manually:\x1b[0m ${url}\n`);
        resolve({ launched: false });
      }
    });

    // Detach immediately — we do not wait for the browser to close.
    child.unref();

    // setImmediate runs *after* the nextTick queue where spawn's ENOENT error
    // is emitted, so any immediate spawn failure will be caught first.
    setImmediate(() => {
      if (!resolved) {
        resolved = true;
        resolve({ launched: true });
      }
    });
  });
}
