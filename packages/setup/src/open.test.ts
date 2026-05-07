/**
 * open.test.ts — unit tests for the cross-platform browser launcher.
 *
 * Tests are split into two layers:
 *  1. resolveCommand — pure function, no mocking needed.
 *  2. openInBrowser  — integration tests with child_process.spawn mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// vi.mock is hoisted to the top of the compiled output by vitest, so these
// mocks are active before the real module imports below are resolved.
vi.mock('node:child_process');
vi.mock('node:fs');

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { openInBrowser, resolveCommand } from './open.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Creates a minimal ChildProcess-like EventEmitter stub. */
function makeMockChild(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  (emitter as unknown as { unref: () => void }).unref = vi.fn();
  return emitter;
}

/** Writes captured via the mock stdout. */
function mockStdout(): { stream: NodeJS.WriteStream; lines: string[] } {
  const lines: string[] = [];
  const stream = {
    write: (s: string) => {
      lines.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, lines };
}

// ── resolveCommand (pure, no I/O) ────────────────────────────────────────────

describe('resolveCommand', () => {
  const URL = 'https://example.com/start';

  it('darwin → open <url>', () => {
    expect(resolveCommand(URL, 'darwin')).toEqual({
      bin: 'open',
      args: [URL],
    });
  });

  it('win32 → cmd /c start "" <url>', () => {
    expect(resolveCommand(URL, 'win32')).toEqual({
      bin: 'cmd',
      args: ['/c', 'start', '', URL],
    });
  });

  it('linux (non-WSL, no wslContent) → xdg-open <url>', () => {
    expect(resolveCommand(URL, 'linux')).toEqual({
      bin: 'xdg-open',
      args: [URL],
    });
  });

  it('linux (non-WSL, wslContent without microsoft) → xdg-open <url>', () => {
    expect(resolveCommand(URL, 'linux', 'Linux version 5.15.0-generic')).toEqual({
      bin: 'xdg-open',
      args: [URL],
    });
  });

  it('linux (WSL) → cmd.exe /c start "" <url>', () => {
    const wslVersion =
      'Linux version 5.15.90.1-microsoft-standard-WSL2 (oe-user@oe-host)';
    expect(resolveCommand(URL, 'linux', wslVersion)).toEqual({
      bin: 'cmd.exe',
      args: ['/c', 'start', '', URL],
    });
  });

  it('WSL detection is case-insensitive for "microsoft"', () => {
    expect(resolveCommand(URL, 'linux', 'Microsoft WSL kernel')).toEqual({
      bin: 'cmd.exe',
      args: ['/c', 'start', '', URL],
    });
  });

  it('other platform (e.g. freebsd) → xdg-open <url>', () => {
    expect(resolveCommand(URL, 'freebsd' as NodeJS.Platform)).toEqual({
      bin: 'xdg-open',
      args: [URL],
    });
  });

  it('URL is passed as a single argv element — never shell-interpolated', () => {
    // A URL that looks like a shell injection attempt must survive intact.
    const malicious = 'https://example.com/foo"; rm -rf /';
    const { args } = resolveCommand(malicious, 'darwin');
    expect(args).toHaveLength(1);
    expect(args[0]).toBe(malicious);
  });
});

// ── openInBrowser (spawn mocked) ─────────────────────────────────────────────

describe('openInBrowser', () => {
  const URL = 'https://example.com/wizard';

  // Keep a reference to the saved platform value so we can restore it.
  let savedPlatform: NodeJS.Platform;

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: readFileSync throws (non-linux or no /proc/version).
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    savedPlatform = process.platform;
  });

  afterEach(() => {
    // Restore process.platform if any test changed it.
    Object.defineProperty(process, 'platform', {
      value: savedPlatform,
      writable: false,
      configurable: true,
    });
  });

  // ── helper to set the test platform ──────────────────────────────────────

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
      value: p,
      writable: false,
      configurable: true,
    });
  }

  // ── success paths ─────────────────────────────────────────────────────────

  it('darwin: spawns "open" with the URL and resolves { launched: true }', async () => {
    setPlatform('darwin');
    const child = makeMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const result = await openInBrowser(URL);

    expect(result).toEqual({ launched: true });
    expect(spawn).toHaveBeenCalledOnce();
    const [bin, args, opts] = vi.mocked(spawn).mock.calls[0]!;
    expect(bin).toBe('open');
    expect(args).toEqual([URL]);
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('win32: spawns "cmd" with /c start "" <url> and resolves { launched: true }', async () => {
    setPlatform('win32');
    const child = makeMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const result = await openInBrowser(URL);

    expect(result).toEqual({ launched: true });
    const [bin, args] = vi.mocked(spawn).mock.calls[0]!;
    expect(bin).toBe('cmd');
    expect(args).toEqual(['/c', 'start', '', URL]);
  });

  it('linux (non-WSL): spawns "xdg-open" with the URL and resolves { launched: true }', async () => {
    setPlatform('linux');
    // readFileSync returns a non-WSL /proc/version.
    // Cast through unknown because vi.mock infers the broadest overload signature.
    vi.mocked(readFileSync).mockReturnValue(
      'Linux version 5.15.0-generic #33-Ubuntu SMP' as unknown as ReturnType<typeof readFileSync>,
    );
    const child = makeMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const result = await openInBrowser(URL);

    expect(result).toEqual({ launched: true });
    const [bin, args] = vi.mocked(spawn).mock.calls[0]!;
    expect(bin).toBe('xdg-open');
    expect(args).toEqual([URL]);
  });

  // ── WSL path ──────────────────────────────────────────────────────────────

  it('linux (WSL): reads /proc/version, detects microsoft, spawns cmd.exe', async () => {
    setPlatform('linux');
    vi.mocked(readFileSync).mockReturnValue(
      'Linux version 5.15.90.1-microsoft-standard-WSL2' as unknown as ReturnType<typeof readFileSync>,
    );
    const child = makeMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const result = await openInBrowser(URL);

    expect(result).toEqual({ launched: true });
    const [bin, args] = vi.mocked(spawn).mock.calls[0]!;
    expect(bin).toBe('cmd.exe');
    expect(args).toEqual(['/c', 'start', '', URL]);
  });

  it('linux (WSL): /proc/version read fails gracefully → falls back to xdg-open', async () => {
    setPlatform('linux');
    // readFileSync already throws by default (set in beforeEach).
    const child = makeMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    const result = await openInBrowser(URL);

    expect(result).toEqual({ launched: true });
    const [bin] = vi.mocked(spawn).mock.calls[0]!;
    expect(bin).toBe('xdg-open');
  });

  // ── headless fallback (ENOENT) ────────────────────────────────────────────

  it('linux: resolves { launched: false } and prints fallback when xdg-open is missing', async () => {
    setPlatform('linux');
    const child = makeMockChild();
    vi.mocked(spawn).mockImplementation(() => {
      // Emit ENOENT on next tick, just like Node.js does for a missing binary.
      process.nextTick(() => {
        child.emit(
          'error',
          Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }),
        );
      });
      return child;
    });

    const { stream, lines } = mockStdout();
    const result = await openInBrowser(URL, { stdout: stream });

    expect(result).toEqual({ launched: false });
    // The fallback message should contain both the label and the URL.
    const combined = lines.join('');
    expect(combined).toContain('Open this URL manually:');
    expect(combined).toContain(URL);
  });

  it('darwin: resolves { launched: false } and prints fallback on any spawn error', async () => {
    setPlatform('darwin');
    const child = makeMockChild();
    vi.mocked(spawn).mockImplementation(() => {
      process.nextTick(() => {
        child.emit('error', new Error('EPERM: operation not permitted'));
      });
      return child;
    });

    const { stream, lines } = mockStdout();
    const result = await openInBrowser(URL, { stdout: stream });

    expect(result).toEqual({ launched: false });
    expect(lines.join('')).toContain('Open this URL manually:');
  });

  // ── spawn options ─────────────────────────────────────────────────────────

  it('child process is unref()-ed after spawning', async () => {
    setPlatform('darwin');
    const child = makeMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    await openInBrowser(URL);

    const unref = (child as unknown as { unref: ReturnType<typeof vi.fn> }).unref;
    expect(unref).toHaveBeenCalledOnce();
  });

  it('uses detached:true and stdio:"ignore"', async () => {
    setPlatform('darwin');
    const child = makeMockChild();
    vi.mocked(spawn).mockReturnValue(child);

    await openInBrowser(URL);

    const [, , spawnOpts] = vi.mocked(spawn).mock.calls[0]!;
    expect(spawnOpts?.detached).toBe(true);
    expect(spawnOpts?.stdio).toBe('ignore');
  });
});
