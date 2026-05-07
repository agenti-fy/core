/**
 * prompts.ts — readline-based prompt primitives for the agentify-setup wizard.
 *
 * All prompts accept an injectable `{ stdin, stdout }` pair so tests can drive
 * them with PassThrough streams.  The default pair is the real process streams.
 *
 * No third-party prompt deps — Node 22's `node:readline` is sufficient.
 */

import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

// ── Types ─────────────────────────────────────────────────────────────────

/** Dependency-injectable I/O streams.  Defaults to process stdin/stdout. */
export interface IoStreams {
  stdin: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  stdout: Writable & { isTTY?: boolean };
}

/** Default streams — real process I/O. */
const DEFAULT_IO: IoStreams = {
  stdin: process.stdin,
  stdout: process.stdout,
};

/** Thrown when the user aborts a prompt (EOF / Ctrl-C). */
export class PromptCancelled extends Error {
  constructor(message = 'Prompt cancelled') {
    super(message);
    this.name = 'PromptCancelled';
  }
}

// ── ANSI helpers (~5 lines, no chalk dep) ────────────────────────────────

function isTTY(io: IoStreams): boolean {
  return io.stdout.isTTY === true;
}

function ansi(code: string, text: string, io: IoStreams): string {
  return isTTY(io) ? `\x1b[${code}m${text}\x1b[0m` : text;
}

// ── Print helpers ─────────────────────────────────────────────────────────

/** Print a prominent section header to stdout. */
export function printSection(title: string, io: IoStreams = DEFAULT_IO): void {
  const line = `\n${ansi('1;36', `▸ ${title}`, io)}\n`;
  io.stdout.write(line);
}

/** Print a success message (✔ prefix, green). */
export function printOk(message: string, io: IoStreams = DEFAULT_IO): void {
  io.stdout.write(`${ansi('32', '✔', io)} ${message}\n`);
}

/** Print a warning message (⚠ prefix, yellow). */
export function printWarn(message: string, io: IoStreams = DEFAULT_IO): void {
  io.stdout.write(`${ansi('33', '⚠', io)} ${message}\n`);
}

/** Print an error message (✖ prefix, red). */
export function printErr(message: string, io: IoStreams = DEFAULT_IO): void {
  io.stdout.write(`${ansi('31', '✖', io)} ${message}\n`);
}

// ── Internal: buffered line reader ────────────────────────────────────────

/**
 * A buffered line reader wrapping readline.Interface.
 *
 * Lines emitted by readline are either dispatched immediately to a waiting
 * consumer or queued for the next `readLine()` call.  EOF (stream close)
 * resolves any pending `readLine()` with `null`.
 *
 * This avoids a fundamental limitation of `readline.question()` /
 * `readline/promises.question()`: those APIs miss lines that arrive between
 * iterations of a re-prompt loop, because they listen for the *next* 'line'
 * event rather than draining a queue.
 */
class LineReader {
  private readonly queue: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private closed = false;
  private readonly rl: readline.Interface;

  constructor(io: IoStreams) {
    this.rl = readline.createInterface({
      input: io.stdin,
      output: io.stdout,
      terminal: false,
    });

    this.rl.on('line', (line: string) => {
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter(line);
      } else {
        this.queue.push(line);
      }
    });

    this.rl.on('close', () => {
      this.closed = true;
      const pending = this.waiters.splice(0);
      for (const waiter of pending) waiter(null);
    });
  }

  /**
   * Write `promptText` to stdout, then return the next line (or null on EOF).
   */
  async prompt(promptText: string, io: IoStreams): Promise<string | null> {
    io.stdout.write(promptText);
    return this.readLine();
  }

  /** Return the next buffered line, or wait for one.  Returns null on EOF. */
  async readLine(): Promise<string | null> {
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this.closed) return null;
    return new Promise<string | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    this.rl.close();
  }
}

/** Format the prompt text, including an optional default hint. */
function formatQuestion(question: string, defaultValue?: string): string {
  const hint = defaultValue !== undefined ? ` [${defaultValue}]` : '';
  return `${question}${hint}: `;
}

// ── ask ───────────────────────────────────────────────────────────────────

export interface AskOptions {
  /** Default value returned when the user submits an empty line. */
  default?: string;
  /** Validator: return a non-null error string to reject and re-prompt. */
  validate?: (s: string) => string | null;
}

/**
 * Prompt for a free-text answer.
 *
 * Re-prompts on validation failure.  Uses the default when the user submits
 * an empty line and a default is configured.  Throws `PromptCancelled` on EOF.
 */
export async function ask(
  question: string,
  opts: AskOptions = {},
  io: IoStreams = DEFAULT_IO,
): Promise<string> {
  const reader = new LineReader(io);
  try {
    for (;;) {
      const line = await reader.prompt(formatQuestion(question, opts.default), io);
      if (line === null) throw new PromptCancelled();

      let answer = line;
      if (answer === '' && opts.default !== undefined) {
        answer = opts.default;
      }

      if (opts.validate) {
        const err = opts.validate(answer);
        if (err !== null) {
          printErr(err, io);
          continue;
        }
      }

      return answer;
    }
  } finally {
    reader.close();
  }
}

// ── askMasked ─────────────────────────────────────────────────────────────

/**
 * Prompt for a secret value.
 *
 * While reading, raw mode is enabled so keystrokes are captured one at a time
 * and each is echoed as `*`.  Backspace deletes the last char.
 * EOF and Ctrl-C reject with a `PromptCancelled` error so the driver can
 * persist state and exit cleanly.
 */
export async function askMasked(
  question: string,
  io: IoStreams = DEFAULT_IO,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const stdin = io.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
    const stdout = io.stdout;

    const hasRawMode = typeof stdin.setRawMode === 'function';

    // Write the question without a trailing newline so the * chars follow it.
    stdout.write(`${question}: `);

    let buffer = '';

    function restore(): void {
      if (hasRawMode) stdin.setRawMode(false);
      stdout.write('\n');
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
    }

    function onData(chunk: Buffer | string): void {
      const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;

      for (const ch of str) {
        const code = ch.charCodeAt(0);

        // Ctrl-C (0x03) or Ctrl-D (0x04) — cancel.
        if (code === 0x03 || code === 0x04) {
          restore();
          reject(new PromptCancelled());
          return;
        }

        // Enter (CR 0x0d or LF 0x0a) — submit.
        if (code === 0x0d || code === 0x0a) {
          restore();
          resolve(buffer);
          return;
        }

        // Backspace (0x7f or 0x08).
        if (code === 0x7f || code === 0x08) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            // Erase last * on screen: move left, space, move left again.
            stdout.write('\b \b');
          }
          continue;
        }

        // Printable character.
        buffer += ch;
        stdout.write('*');
      }
    }

    function onEnd(): void {
      restore();
      // EOF with data already typed: resolve with what we have.
      if (buffer.length > 0) {
        resolve(buffer);
      } else {
        reject(new PromptCancelled());
      }
    }

    if (hasRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.once('end', onEnd);
  });
}

// ── askChoice ─────────────────────────────────────────────────────────────

export interface Choice<T extends string> {
  value: T;
  label: string;
}

export interface AskChoiceOptions<T extends string> {
  default?: T;
}

/** Map a 0-based list index to a display key: 0→'1', 1→'2', …, 9→'a', 10→'b', … */
function indexToKey(i: number): string {
  if (i < 9) return String(i + 1);
  return String.fromCharCode('a'.charCodeAt(0) + (i - 9));
}

/** Map a key string back to a 0-based index, or null if unrecognised. */
function keyToIndex(key: string): number | null {
  if (key.length !== 1) return null;
  const code = key.charCodeAt(0);
  if (code >= '1'.charCodeAt(0) && code <= '9'.charCodeAt(0)) {
    return code - '1'.charCodeAt(0);
  }
  if (code >= 'a'.charCodeAt(0) && code <= 'z'.charCodeAt(0)) {
    return 9 + (code - 'a'.charCodeAt(0));
  }
  return null;
}

/**
 * Present a numbered list of choices and accept a single-key selection.
 *
 * Keys 1-9 select by position (1-indexed); a-z keys work for choices beyond 9.
 * Enter with no input uses the default if provided.
 *
 * On TTY with raw mode: single-keystroke.
 * Without raw mode (e.g. PassThrough in tests): line-based readline read.
 */
export async function askChoice<T extends string>(
  question: string,
  choices: readonly Choice<T>[],
  opts: AskChoiceOptions<T> = {},
  io: IoStreams = DEFAULT_IO,
): Promise<T> {
  if (choices.length === 0) {
    throw new Error('askChoice: choices list must not be empty');
  }

  const defaultIdx = opts.default !== undefined
    ? choices.findIndex((c) => c.value === opts.default)
    : -1;

  function renderMenu(): void {
    io.stdout.write(`${question}\n`);
    choices.forEach((choice, i) => {
      const key = indexToKey(i);
      const marker = i === defaultIdx ? ansi('1', `(${key})`, io) : `(${key})`;
      const label = i === defaultIdx ? ansi('1', choice.label, io) : choice.label;
      io.stdout.write(`  ${marker} ${label}\n`);
    });
    const hint = defaultIdx >= 0 ? ` [${indexToKey(defaultIdx)}]` : '';
    io.stdout.write(`Your choice${hint}: `);
  }

  renderMenu();

  const stdin = io.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
  const hasRawMode = typeof stdin.setRawMode === 'function';

  if (hasRawMode) {
    // Single-keystroke path — raw mode.
    return new Promise<T>((resolve, reject) => {
      function restore(): void {
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        stdin.removeListener('end', onEnd);
      }

      function onData(chunk: Buffer | string): void {
        const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        const ch = str[0];
        if (!ch) return;

        const code = ch.charCodeAt(0);

        // Ctrl-C / Ctrl-D
        if (code === 0x03 || code === 0x04) {
          io.stdout.write('\n');
          restore();
          reject(new PromptCancelled());
          return;
        }

        // Enter with a default.
        if ((code === 0x0d || code === 0x0a) && defaultIdx >= 0) {
          io.stdout.write('\n');
          restore();
          resolve(choices[defaultIdx]!.value);
          return;
        }

        const idx = keyToIndex(ch);
        if (idx !== null && idx >= 0 && idx < choices.length) {
          io.stdout.write(`${ch}\n`);
          restore();
          resolve(choices[idx]!.value);
          return;
        }

        // Invalid key — re-render.
        io.stdout.write('\n');
        printWarn(`Invalid choice: "${ch}"`, io);
        renderMenu();
      }

      function onEnd(): void {
        restore();
        if (defaultIdx >= 0) {
          resolve(choices[defaultIdx]!.value);
        } else {
          reject(new PromptCancelled());
        }
      }

      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
      stdin.once('end', onEnd);
    });
  } else {
    // Line-based fallback — used in tests with PassThrough streams.
    const reader = new LineReader(io);
    try {
      for (;;) {
        const line = await reader.readLine();

        // EOF
        if (line === null) {
          if (defaultIdx >= 0) return choices[defaultIdx]!.value;
          throw new PromptCancelled();
        }

        const key = line.trim();

        // Empty input → default.
        if (key === '' && defaultIdx >= 0) {
          return choices[defaultIdx]!.value;
        }

        const idx = keyToIndex(key);
        if (idx !== null && idx >= 0 && idx < choices.length) {
          return choices[idx]!.value;
        }

        printWarn(`Invalid choice: "${key}"`, io);
        renderMenu();
      }
    } finally {
      reader.close();
    }
  }
}

// ── askYesNo ──────────────────────────────────────────────────────────────

export interface AskYesNoOptions {
  default?: boolean;
}

/**
 * Prompt for a yes/no answer.
 *
 * Accepts `y`/`yes` / `n`/`no` (case-insensitive).  If a default is supplied
 * the hint shows it capitalised (e.g. `[Y/n]`).  Enter with no input uses the
 * default.  Throws `PromptCancelled` on EOF.
 */
export async function askYesNo(
  question: string,
  opts: AskYesNoOptions = {},
  io: IoStreams = DEFAULT_IO,
): Promise<boolean> {
  const hint =
    opts.default === true ? '[Y/n]' :
    opts.default === false ? '[y/N]' :
    '[y/n]';

  const reader = new LineReader(io);
  try {
    for (;;) {
      const line = await reader.prompt(`${question} ${hint}: `, io);
      if (line === null) throw new PromptCancelled();

      const answer = line.trim().toLowerCase();

      if (answer === '' && opts.default !== undefined) {
        return opts.default;
      }

      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;

      printWarn('Please enter y or n.', io);
    }
  } finally {
    reader.close();
  }
}
