/**
 * prompts.test.ts — unit tests for the readline-based prompt helpers.
 *
 * All tests inject PassThrough streams so no real TTY is needed.  stdin writes
 * simulate keyboard input; stdout captures are checked for the expected output.
 */

import { PassThrough } from 'node:stream';
import { describe, it, expect } from 'vitest';
import {
  ask,
  askMasked,
  askChoice,
  askYesNo,
  printSection,
  printOk,
  printWarn,
  printErr,
  PromptCancelled,
  type IoStreams,
} from './prompts.js';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Create a fake IoStreams pair driven by canned lines. */
function makeIo(lines: string[]): IoStreams & { output: () => string } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  // Feed each line followed by a newline; end the stream when exhausted.
  setImmediate(() => {
    for (const line of lines) {
      stdin.write(`${line}\n`);
    }
    stdin.end();
  });

  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

  return {
    stdin,
    stdout,
    output: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/** Create a PassThrough stdin that ends immediately (simulates EOF). */
function makeEofIo(): IoStreams & { output: () => string } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();

  setImmediate(() => stdin.end());

  const chunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

  return { stdin, stdout, output: () => Buffer.concat(chunks).toString('utf8') };
}

// ── printSection / printOk / printWarn / printErr ────────────────────────

describe('print helpers', () => {
  it('printSection writes a section header', () => {
    const io = makeIo([]);
    printSection('My Section', io);
    expect(io.output()).toContain('My Section');
  });

  it('printOk writes the message with ✔', () => {
    const io = makeIo([]);
    printOk('everything is fine', io);
    expect(io.output()).toContain('everything is fine');
    expect(io.output()).toContain('✔');
  });

  it('printWarn writes the message with ⚠', () => {
    const io = makeIo([]);
    printWarn('something odd', io);
    expect(io.output()).toContain('something odd');
    expect(io.output()).toContain('⚠');
  });

  it('printErr writes the message with ✖', () => {
    const io = makeIo([]);
    printErr('it broke', io);
    expect(io.output()).toContain('it broke');
    expect(io.output()).toContain('✖');
  });

  it('does not emit ANSI codes when isTTY is falsy', () => {
    const io = makeIo([]);
    // PassThrough has no isTTY; should produce plain text.
    printOk('plain', io);
    expect(io.output()).not.toContain('\x1b[');
  });

  it('emits ANSI codes when isTTY is true', () => {
    const io = makeIo([]);
    (io.stdout as NodeJS.WriteStream & { isTTY: boolean }).isTTY = true;
    printOk('colored', io);
    expect(io.output()).toContain('\x1b[');
  });
});

// ── ask ───────────────────────────────────────────────────────────────────

describe('ask', () => {
  it('returns the typed answer', async () => {
    const io = makeIo(['hello']);
    const result = await ask('Enter something', {}, io);
    expect(result).toBe('hello');
  });

  it('returns the default when the user presses Enter on an empty line', async () => {
    const io = makeIo(['']);
    const result = await ask('Enter something', { default: 'fallback' }, io);
    expect(result).toBe('fallback');
  });

  it('re-prompts when validator returns a non-null error', async () => {
    // First answer: 'bad'. Second: 'good'.
    const io = makeIo(['bad', 'good']);
    const validate = (s: string) => (s === 'bad' ? 'Not allowed' : null);
    const result = await ask('Enter something', { validate }, io);
    expect(result).toBe('good');
    expect(io.output()).toContain('Not allowed');
  });

  it('passes validation when validator returns null', async () => {
    const io = makeIo(['ok']);
    const result = await ask('Enter', { validate: () => null }, io);
    expect(result).toBe('ok');
  });

  it('throws PromptCancelled on EOF', async () => {
    const io = makeEofIo();
    await expect(ask('Enter', {}, io)).rejects.toBeInstanceOf(PromptCancelled);
  });

  it('includes the question in stdout output', async () => {
    const io = makeIo(['answer']);
    await ask('What is your name?', {}, io);
    expect(io.output()).toContain('What is your name?');
  });

  it('includes the default hint in the question output', async () => {
    const io = makeIo(['']);
    await ask('Name', { default: 'Alice' }, io);
    expect(io.output()).toContain('[Alice]');
  });
});

// ── askMasked ─────────────────────────────────────────────────────────────

describe('askMasked', () => {
  /**
   * Build a stdin PassThrough that emits individual bytes (simulating raw
   * keystrokes), then ends.  askMasked falls back to line-based reading when
   * setRawMode is absent (PassThrough), but still works because it handles LF.
   */
  function makeMaskedIo(input: string): IoStreams & { output: () => string } {
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    setImmediate(() => {
      // Write input chars then LF (Enter) to simulate submission.
      stdin.write(Buffer.from(input + '\n', 'utf8'));
      stdin.end();
    });

    const chunks: Buffer[] = [];
    stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    return { stdin, stdout, output: () => Buffer.concat(chunks).toString('utf8') };
  }

  it('returns the typed value without echoing it', async () => {
    const io = makeMaskedIo('s3cr3t');
    const result = await askMasked('Password', io);
    expect(result).toBe('s3cr3t');
    // Output should not contain the actual secret.
    expect(io.output()).not.toContain('s3cr3t');
  });

  it('writes * per keystroke instead of the actual character', async () => {
    const io = makeMaskedIo('abc');
    await askMasked('Password', io);
    // Should contain exactly 3 stars for the 3 chars typed.
    expect(io.output()).toContain('***');
  });

  it('throws PromptCancelled on EOF with no input', async () => {
    const io = makeEofIo();
    const promise = askMasked('Password', io);
    void promise.catch(() => {});
    await expect(promise).rejects.toBeInstanceOf(PromptCancelled);
  });

  it('handles Ctrl-C (0x03) by throwing PromptCancelled', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    setImmediate(() => {
      // Simulate Ctrl-C raw byte.
      stdin.write(Buffer.from([0x03]));
      stdin.end();
    });

    const io: IoStreams = { stdin, stdout };
    const promise = askMasked('Password', io);
    void promise.catch(() => {});
    await expect(promise).rejects.toBeInstanceOf(PromptCancelled);
  });

  it('handles backspace by removing the last char', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    setImmediate(() => {
      // Type 'abc', backspace once (DEL 0x7f), then Enter.
      stdin.write(Buffer.from([0x61, 0x62, 0x63, 0x7f, 0x0a]));
      stdin.end();
    });

    const io: IoStreams = { stdin, stdout };
    const result = await askMasked('Password', io);
    expect(result).toBe('ab');
  });

  it('uses setRawMode when available', async () => {
    const stdin = new PassThrough() as PassThrough & {
      setRawMode: (mode: boolean) => void;
      isTTY: boolean;
    };
    const stdout = new PassThrough();
    const rawModeCalls: boolean[] = [];

    stdin.setRawMode = (mode: boolean) => {
      rawModeCalls.push(mode);
    };
    stdin.isTTY = true;

    setImmediate(() => {
      stdin.write(Buffer.from('hi\n', 'utf8'));
      stdin.end();
    });

    const io: IoStreams = { stdin, stdout };
    const result = await askMasked('Password', io);
    expect(result).toBe('hi');
    // setRawMode(true) and setRawMode(false) should both have been called.
    expect(rawModeCalls).toContain(true);
    expect(rawModeCalls).toContain(false);
  });
});

// ── askChoice ─────────────────────────────────────────────────────────────

describe('askChoice', () => {
  const choices = [
    { value: 'a' as const, label: 'Option A' },
    { value: 'b' as const, label: 'Option B' },
    { value: 'c' as const, label: 'Option C' },
  ] as const;

  it('returns the selected value when the user types the key number', async () => {
    const io = makeIo(['2']); // select 'b'
    const result = await askChoice('Pick one', choices, {}, io);
    expect(result).toBe('b');
  });

  it('returns the default when the user presses Enter with a default set', async () => {
    const io = makeIo(['']); // empty line → default
    const result = await askChoice('Pick one', choices, { default: 'c' }, io);
    expect(result).toBe('c');
  });

  it('re-prompts on invalid key input', async () => {
    const io = makeIo(['9', '1']); // 9 out of range, then 1
    const result = await askChoice('Pick one', choices, {}, io);
    expect(result).toBe('a');
    expect(io.output()).toContain('Invalid choice');
  });

  it('throws PromptCancelled on EOF without a default', async () => {
    const io = makeEofIo();
    const promise = askChoice('Pick one', choices, {}, io);
    void promise.catch(() => {});
    await expect(promise).rejects.toBeInstanceOf(PromptCancelled);
  });

  it('resolves default on EOF when default is set', async () => {
    const io = makeEofIo();
    const result = await askChoice('Pick one', choices, { default: 'b' }, io);
    expect(result).toBe('b');
  });

  it('renders all choices in stdout', async () => {
    const io = makeIo(['1']);
    await askChoice('Pick one', choices, {}, io);
    expect(io.output()).toContain('Option A');
    expect(io.output()).toContain('Option B');
    expect(io.output()).toContain('Option C');
  });

  it('throws when choices list is empty', async () => {
    const io = makeIo([]);
    await expect(askChoice('Pick one', [], {}, io)).rejects.toThrow(
      'choices list must not be empty',
    );
  });

  it('handles letter keys for choices beyond 9', async () => {
    const manyChoices = Array.from({ length: 12 }, (_, i) => ({
      value: `v${i}`,
      label: `Label ${i}`,
    }));
    // key 'a' maps to index 9 (0-based).
    const io = makeIo(['a']);
    const result = await askChoice('Pick one', manyChoices, {}, io);
    expect(result).toBe('v9');
  });
});

// ── askYesNo ──────────────────────────────────────────────────────────────

describe('askYesNo', () => {
  it('returns true for "y"', async () => {
    const io = makeIo(['y']);
    const result = await askYesNo('Continue?', {}, io);
    expect(result).toBe(true);
  });

  it('returns true for "yes" (case-insensitive)', async () => {
    const io = makeIo(['YES']);
    const result = await askYesNo('Continue?', {}, io);
    expect(result).toBe(true);
  });

  it('returns false for "n"', async () => {
    const io = makeIo(['n']);
    const result = await askYesNo('Continue?', {}, io);
    expect(result).toBe(false);
  });

  it('returns false for "no"', async () => {
    const io = makeIo(['no']);
    const result = await askYesNo('Continue?', {}, io);
    expect(result).toBe(false);
  });

  it('returns the default when the user presses Enter (default: true)', async () => {
    const io = makeIo(['']);
    const result = await askYesNo('Continue?', { default: true }, io);
    expect(result).toBe(true);
  });

  it('returns the default when the user presses Enter (default: false)', async () => {
    const io = makeIo(['']);
    const result = await askYesNo('Continue?', { default: false }, io);
    expect(result).toBe(false);
  });

  it('re-prompts on invalid input', async () => {
    const io = makeIo(['maybe', 'y']);
    const result = await askYesNo('Continue?', {}, io);
    expect(result).toBe(true);
    expect(io.output()).toContain('Please enter y or n');
  });

  it('throws PromptCancelled on EOF', async () => {
    const io = makeEofIo();
    const promise = askYesNo('Continue?', {}, io);
    void promise.catch(() => {});
    await expect(promise).rejects.toBeInstanceOf(PromptCancelled);
  });

  it('shows [Y/n] hint when default is true', async () => {
    const io = makeIo(['y']);
    await askYesNo('Continue?', { default: true }, io);
    expect(io.output()).toContain('[Y/n]');
  });

  it('shows [y/N] hint when default is false', async () => {
    const io = makeIo(['n']);
    await askYesNo('Continue?', { default: false }, io);
    expect(io.output()).toContain('[y/N]');
  });

  it('shows [y/n] hint when no default is set', async () => {
    const io = makeIo(['y']);
    await askYesNo('Continue?', {}, io);
    expect(io.output()).toContain('[y/n]');
  });
});

// ── PromptCancelled ───────────────────────────────────────────────────────

describe('PromptCancelled', () => {
  it('is an Error subclass', () => {
    const err = new PromptCancelled();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PromptCancelled);
  });

  it('has the expected name', () => {
    expect(new PromptCancelled().name).toBe('PromptCancelled');
  });

  it('accepts a custom message', () => {
    expect(new PromptCancelled('bye').message).toBe('bye');
  });
});
