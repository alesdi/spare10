/**
 * The one place spare10 talks to a terminal directly.
 *
 * Claude Code owns the tty while it runs, and spare10's questions are asked either before it
 * starts or after it is gone — so the terminal here is always ours, and raw mode is safe to
 * take as long as it is always given back.
 *
 * Everything degrades: no tty, a dumb terminal, or a window too narrow for the panel all fall
 * back to the line prompt spare10 has always used, and a run with nobody attached still gets a
 * null answer rather than a hang.
 */

import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { ReadStream, WriteStream, isatty } from 'node:tty';
import {
  MIN_PANEL_WIDTH,
  plainPrompt,
  renderPanel,
  type Caps,
  type PromptView,
} from './panel';
import type { RunConfig, State } from './types';

export type Action = 'prev' | 'next' | 'confirm' | 'yes' | 'no' | 'cancel' | null;

/**
 * One keypress, as an intent. Arrow keys arrive as escape sequences, which is also how a bare
 * Escape arrives — so a lone ESC byte is a cancel and ESC-with-more is a cursor key.
 */
export function keyToAction(bytes: string): Action {
  switch (bytes) {
    case '\u001b[D':
    case '\u001b[A':
    case '\u001bOD':
    case '\u001bOA':
      return 'prev';
    case '\u001b[C':
    case '\u001b[B':
    case '\u001bOC':
    case '\u001bOB':
    case '\t':
      return 'next';
    case '\r':
    case '\n':
      return 'confirm';
    case '\u001b':
    case '\u0003': // Ctrl-C
    case '\u0004': // Ctrl-D
      return 'cancel';
  }
  if (/^[yY]$/.test(bytes)) return 'yes';
  if (/^[nNqQ]$/.test(bytes)) return 'no';
  if (bytes === 'h' || bytes === 'k') return 'prev';
  if (bytes === 'l' || bytes === 'j') return 'next';
  return null;
}

/**
 * Split one read into individual keys.
 *
 * A terminal does not promise one keypress per chunk: paste an answer, or type fast enough,
 * and "→" and Enter arrive in the same read. Escape sequences are taken whole — ESC, then `[`
 * or `O`, then parameters up to a final byte — so a cursor key is never mistaken for a bare
 * Escape followed by junk.
 */
export function splitKeys(bytes: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < bytes.length; ) {
    const intro = bytes[i + 1];
    if (bytes[i] === '\u001b' && (intro === '[' || intro === 'O')) {
      let end = i + 2;
      while (end < bytes.length && !/[@-~]/.test(bytes[end] as string)) end += 1;
      keys.push(bytes.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    keys.push(bytes[i] as string);
    i += 1;
  }
  return keys;
}

export function detectCaps(env: NodeJS.ProcessEnv, columns: number): Caps {
  const dumb = env['TERM'] === 'dumb' || env['TERM'] === undefined;
  const color = !env['NO_COLOR'] && !dumb;
  const locale = env['LC_ALL'] ?? env['LC_CTYPE'] ?? env['LANG'] ?? '';
  return {
    color,
    truecolor: color && /truecolor|24bit/i.test(env['COLORTERM'] ?? ''),
    // An unset locale is the norm on macOS terminals, which are UTF-8 regardless; only an
    // explicitly non-UTF-8 locale, or a dumb terminal, gets the ASCII frame.
    unicode: !dumb && (locale === '' || /utf-?8/i.test(locale)),
    columns,
  };
}

interface Tty {
  /** The controlling terminal, open for reading. Raw mode wraps it; the line prompt does not. */
  fd: number;
  write: (text: string) => void;
  columns: number;
  close: () => void;
}

/** Open the controlling terminal for reading and writing, or null when there is none. */
function openTty(): Tty | null {
  let readFd: number;
  try {
    readFd = openSync('/dev/tty', 'r');
  } catch {
    return null;
  }

  // Writing goes to stderr while that is still the terminal, so the panel interleaves with
  // spare10's other messages in the order they were written. Only a redirected stderr makes
  // us open the terminal a second time.
  let owned: WriteStream | null = null;
  let writeFd = 2;
  if (!process.stderr.isTTY) {
    try {
      writeFd = openSync('/dev/tty', 'w');
      owned = new WriteStream(writeFd);
    } catch {
      writeFd = 2;
    }
  }

  return {
    fd: readFd,
    write: (text) => {
      try {
        writeSync(writeFd, text);
      } catch {
        /* the terminal went away mid-question; the answer still resolves */
      }
    },
    columns: (owned ?? process.stderr).columns || 80,
    close: () => {
      try {
        closeSync(readFd);
      } catch {
        /* already gone */
      }
      try {
        owned?.destroy();
      } catch {
        /* already gone */
      }
    },
  };
}

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
/** Move to the start of the line, clear it, and step up one. */
const eraseUp = (lines: number) => `\r${'\u001b[K\u001b[A'.repeat(lines - 1)}\u001b[K`;

export interface AskInput {
  view: PromptView;
  state: State;
  config: RunConfig;
  /** Which option is highlighted when the panel appears. Defaults to the safe one: "no". */
  initial?: number;
}

/**
 * Ask the question, and answer in the same shape `askTerminal` always did: "y", "n", or null
 * when there is no terminal to ask. The verdict functions stay the sole judges of meaning.
 */
export async function ask({ view, state, config, initial = 1 }: AskInput): Promise<string | null> {
  const tty = openTty();
  if (tty === null) return null;

  const caps = detectCaps(process.env, tty.columns);
  const home = homedir();

  const line = (): string | null => {
    const answer = readLine(tty, plainPrompt(view, state));
    tty.close();
    return answer;
  };

  // A window too narrow for the panel gets the line prompt rather than a folded-up frame.
  if (!isatty(tty.fd) || caps.columns < MIN_PANEL_WIDTH + 2) return line();

  // Raw mode needs the fd wrapped in a stream, and wrapping it puts the fd in non-blocking
  // mode — which is why this happens only once the line prompt has been ruled out, and why
  // `readLine` opens a descriptor of its own rather than sharing this one.
  let input: ReadStream;
  try {
    input = new ReadStream(tty.fd);
    input.setRawMode(true);
  } catch {
    return line();
  }

  let selected = initial;
  let drawn = 0;
  const draw = () => {
    const lines = renderPanel({ view, state, config, selected, caps, home });
    tty.write(`${drawn > 0 ? eraseUp(drawn) : ''}${lines.join('\n')}\n`);
    drawn = lines.length + 1;
  };

  const restore = () => {
    try {
      input.setRawMode(false);
    } catch {
      /* the terminal may already be gone */
    }
    tty.write(SHOW_CURSOR);
  };
  process.once('exit', restore);

  tty.write(HIDE_CURSOR);
  draw();

  // Null here means the same as it always did: nobody was there to answer. A terminal that
  // closes mid-question must not leave the launcher waiting on a key that cannot come.
  const answer = await new Promise<string | null>((resolve) => {
    const finish = (value: string | null) => {
      input.off('data', onData);
      input.off('end', gone);
      input.off('error', gone);
      resolve(value);
    };
    const gone = () => finish(null);
    const onData = (chunk: Buffer) => {
      for (const key of splitKeys(chunk.toString('utf8'))) {
        const action = keyToAction(key);
        if (action === 'prev' || action === 'next') {
          const moved = action === 'next' ? selected + 1 : selected - 1;
          selected = (moved + view.choices.length) % view.choices.length;
          draw();
          continue;
        }
        if (action === 'yes' || action === 'no') {
          selected = action === 'yes' ? 0 : 1;
          draw();
          finish(action === 'yes' ? 'y' : 'n');
          return;
        }
        if (action === 'confirm') {
          finish(selected === 0 ? 'y' : 'n');
          return;
        }
        if (action === 'cancel') {
          selected = 1;
          draw();
          finish('n');
          return;
        }
      }
    };
    input.on('data', onData);
    input.once('end', gone);
    input.once('error', gone);
    input.resume();
  });

  restore();
  process.off('exit', restore);
  try {
    input.destroy(); // takes the descriptor with it
  } catch {
    /* already gone */
  }
  return answer;
}

/**
 * The prompt for terminals that cannot take the panel: one line, one typed answer, read with
 * a blocking `readSync` on a descriptor of its own — a descriptor that has been through
 * `tty.ReadStream` is non-blocking, and would answer EAGAIN instead of waiting for the key.
 */
function readLine(tty: Tty, question: string): string | null {
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r');
  } catch {
    return null;
  }
  tty.write(question);
  const byte = Buffer.alloc(1);
  let answer = '';
  try {
    while (readSync(fd, byte, 0, 1, null) > 0) {
      const char = byte.toString('utf8');
      if (char === '\n' || char === '\r') break;
      answer += char;
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  return answer.trim();
}
