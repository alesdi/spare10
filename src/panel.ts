/**
 * Everything spare10 draws when it has to ask the human a question.
 *
 * Pure: a panel is a function of state, terminal capabilities and which option is selected,
 * so the whole look is testable without a terminal. `src/terminal.ts` owns the tty.
 */

import { LIMITS, remaining, tripPoint, type Limit, type RunConfig, type SessionInfo, type State } from './types';
import { formatResetTime } from './decide';

export interface Caps {
  /** ANSI colour is safe to emit. */
  color: boolean;
  /** 24-bit colour is safe to emit; otherwise the 256-colour cube is used. */
  truecolor: boolean;
  /** Box drawing and block characters are safe to emit. */
  unicode: boolean;
  columns: number;
}

/** Below this the frame costs more than it gives, and the caller drops to plain lines. */
export const MIN_PANEL_WIDTH = 46;
const MAX_PANEL_WIDTH = 78;

const ANSI = /\u001b\[[0-9;]*m/g;
export const visibleWidth = (text: string): number => text.replace(ANSI, '').length;

/** The Claude Code mark, as close as a character cell gets. */
const CLAUDE_RGB: [number, number, number] = [0xd9, 0x77, 0x57];
const CLAUDE_256 = 173;
const EYE_RGB: [number, number, number] = [0x26, 0x26, 0x24];
const EYE_256 = 236;
const DIM_256 = 245;

export interface Palette {
  brand: (text: string) => string;
  dim: (text: string) => string;
  bold: (text: string) => string;
  /** Selected option: reversed out of the brand colour. */
  chosen: (text: string) => string;
}

export function palette(caps: Caps): Palette {
  if (!caps.color) {
    const plain = (text: string) => text;
    return { brand: plain, dim: plain, bold: plain, chosen: (text) => `[${text}]` };
  }
  const fg = caps.truecolor
    ? `\u001b[38;2;${CLAUDE_RGB[0]};${CLAUDE_RGB[1]};${CLAUDE_RGB[2]}m`
    : `\u001b[38;5;${CLAUDE_256}m`;
  const bg = caps.truecolor
    ? `\u001b[48;2;${CLAUDE_RGB[0]};${CLAUDE_RGB[1]};${CLAUDE_RGB[2]}m`
    : `\u001b[48;5;${CLAUDE_256}m`;
  return {
    brand: (text) => `${fg}${text}\u001b[39m`,
    dim: (text) => `\u001b[38;5;${DIM_256}m${text}\u001b[39m`,
    bold: (text) => `\u001b[1m${text}\u001b[22m`,
    chosen: (text) => `${bg}\u001b[38;5;${EYE_256}m\u001b[1m${text}\u001b[0m`,
  };
}

/**
 * The Claude Code mark, exactly as Claude Code draws it in its own startup header: three rows
 * of quadrant blocks in the brand colour, with the session's details set beside them.
 */
const MARK = [' ▐▛███▛█', '▝▜██████▀', '  ▝▝ ▝▝'];
const MARK_WIDTH = Math.max(...MARK.map((row) => row.length));

/** The mark as one string per row, or nothing at all when the terminal cannot draw it. */
export function renderMark(caps: Caps): string[] {
  // Without colour the blocks are a grey smudge rather than a mark, and without unicode they
  // are mojibake. The header text carries the meaning either way.
  if (!caps.unicode || !caps.color) return [];
  const p = palette(caps);
  return MARK.map((row) => p.brand(row.padEnd(MARK_WIDTH)));
}

/** `~/src/thing` rather than `/Users/me/src/thing`, the way Claude Code writes it. */
export function tildePath(path: string, home: string): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * The session's own header, rebuilt from the status line payload it sent us.
 *
 * Whatever is missing is simply left out: the fields come from an undocumented payload, and a
 * header with one line fewer is better than one with "unknown" in it.
 */
export function headerLines(session: SessionInfo | null, home: string, p: Palette): string[] {
  const name = p.bold('Claude Code');
  const version = session?.version ? ` ${p.dim(`v${session.version}`)}` : '';
  const lines = [`${name}${version}`];

  const model = session?.model ?? null;
  if (model !== null) {
    const effort = session?.effort ? ` with ${session.effort} effort` : '';
    const fast = session?.fastMode ? ' · fast mode' : '';
    lines.push(p.dim(`${model}${effort}${fast}`));
  }
  if (session?.cwd) lines.push(p.dim(tildePath(session.cwd, home)));
  return lines;
}

const BAR = { unicode: { filled: '█', empty: '▒' }, ascii: { filled: '#', empty: '-' } };

/**
 * Usage as a bar, drawn over the whole window so the reserve is the tail of it. Only a limit
 * into its reserve is drawn in the brand colour; the other stays gray, so the eye goes straight
 * to the one that stopped the session.
 */
export function usageBar(pct: number, width: number, p: Palette, unicode: boolean, hot = true): string {
  const glyph = unicode ? BAR.unicode : BAR.ascii;
  const cells = Math.max(4, width);
  const filled = Math.min(cells, Math.max(0, Math.round((pct / 100) * cells)));
  const fill = hot ? p.brand : p.dim;
  return `${fill(glyph.filled.repeat(filled))}${p.dim(glyph.empty.repeat(cells - filled))}`;
}

/**
 * One limit's quota in one line, the only place the figures are worded. `short` drops the
 * used figure, which the bar beside it already shows, for panels too narrow to take it all.
 */
export function factsLine(state: State, limit: Limit, short = false): string {
  const { pct, resetsAt } = state.limits[limit];
  const resets = `resets ${formatResetTime(resetsAt)}`;
  if (pct === null) return `quota unknown · ${resets}`;
  return `${short ? '' : `${pct}% used · `}${remaining(pct)}% left · ${resets}`;
}

/** The limits there is something to show for. An unknown limit is left out, not guessed at. */
const known = (state: State): Limit[] => LIMITS.filter((limit) => state.limits[limit].pct !== null);

const LABEL_WIDTH = Math.max(...LIMITS.map((limit) => limit.length));
/** A bar shorter than this is noise; the figures stand alone instead. */
const MIN_BAR = 6;

/** The reserve, once when both limits share it and in limit order when they do not. */
export function reserveTag(config: RunConfig): string {
  const { session, weekly } = config.reserve;
  return session === weekly ? `${session}% reserve` : `${session}% · ${weekly}% reserve`;
}

export interface Choice {
  label: string;
  /** One line explaining what this option costs, shown only while it is selected. */
  hint: string;
}

export interface PromptView {
  session: SessionInfo | null;
  /** One sentence: what happened. */
  headline: string;
  /** What the user should know before answering, already split into sentences. */
  body: string[];
  choices: [Choice, Choice];
}

export interface PanelInput {
  view: PromptView;
  state: State;
  config: RunConfig;
  selected: number;
  caps: Caps;
  home: string;
}

/** Colour-safe truncation: only ever applied to lines built from a single style. */
function clip(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  const plain = text.replace(ANSI, '');
  return `${plain.slice(0, Math.max(1, width - 1))}…`;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== '') out.push(line);
  return out;
}

const BOX = {
  unicode: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  ascii: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
};

export function panelWidth(columns: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, columns - 2));
}

/** The option row: the selected one reversed out, the other quiet. */
function choiceRow(choices: [Choice, Choice], selected: number, p: Palette): string {
  return choices
    .map((choice, index) =>
      index === selected ? p.chosen(` ${choice.label} `) : p.dim(` ${choice.label} `),
    )
    .join('  ');
}

/**
 * The whole panel, as lines ready to write to a terminal. No trailing newlines: the caller
 * decides how they are joined, because redrawing in place needs to erase each line first.
 */
export function renderPanel({ view, state, config, selected, caps, home }: PanelInput): string[] {
  const p = palette(caps);
  const box = caps.unicode ? BOX.unicode : BOX.ascii;
  const width = panelWidth(caps.columns);
  const text = width - 6; // two borders and one space of breathing room on each side

  // The session's header stands above the card, where Claude Code itself puts it: it belongs
  // to the session, not to the question, and boxing it would claim it as spare10's own.
  const mark = renderMark(caps);
  const header = headerLines(view.session, home, p);
  const markWidth = mark.length > 0 ? MARK_WIDTH : 0;
  const gap = markWidth > 0 ? 2 : 0;
  const above: string[] = [];
  for (let row = 0; row < Math.max(mark.length, header.length); row += 1) {
    const art = (mark[row] ?? '').padEnd(markWidth);
    above.push(`${art}${' '.repeat(gap)}${clip(header[row] ?? '', width - markWidth - gap)}`.trimEnd());
  }

  const content: string[] = [];
  const push = (line = '') => content.push(line);

  for (const line of wrap(view.headline, text)) push(p.bold(line));

  // One bar per limit, all the same length so they read as a column. The widest facts line
  // sets it: the figures matter more than the bar, so a narrow panel shortens the figures
  // first and only then gives up the bar.
  const shown = known(state);
  const room = (short: boolean) =>
    text - LABEL_WIDTH - 4 - Math.max(0, ...shown.map((limit) => factsLine(state, limit, short).length));
  const short = room(false) < MIN_BAR;
  const barWidth = room(short);
  for (const limit of shown) {
    const facts = p.dim(factsLine(state, limit, short));
    const name = p.dim(limit.padEnd(LABEL_WIDTH));
    if (barWidth < MIN_BAR) push(`${name}  ${facts}`);
    else {
      const pct = state.limits[limit].pct as number;
      const bar = usageBar(pct, barWidth, p, caps.unicode, pct >= tripPoint(config, limit));
      push(`${name}  ${bar}  ${facts}`);
    }
  }

  push();
  for (const paragraph of view.body) for (const line of wrap(paragraph, text)) push(p.dim(line));

  push();
  push(choiceRow(view.choices, selected, p));
  // Both hints are measured, and the shorter one padded out, so the panel keeps its height
  // as the selection moves: a frame that grows and shrinks under the arrow keys reads as a
  // glitch, and the redraw would have to erase a different number of lines each time.
  const hints = view.choices.map((choice) => wrap(choice.hint, text));
  const hintRows = Math.max(...hints.map((lines) => lines.length));
  const chosen = hints[selected] as string[];
  for (let row = 0; row < hintRows; row += 1) push(p.dim(chosen[row] ?? ''));

  push();
  const keys = caps.unicode
    ? '←/→ choose · enter confirm · esc cancel'
    : 'left/right choose, enter confirm, esc cancel';
  for (const line of wrap(keys, text)) push(p.dim(line));

  const title = ` ${p.brand(p.bold('spare10'))} `;
  const reserve = reserveTag(config);
  const fill = Math.max(1, width - 6 - visibleWidth(title) - visibleWidth(reserve));
  const top = `${box.tl}${box.h}${title}${box.h.repeat(fill)} ${p.dim(reserve)} ${box.h}${box.tr}`;

  const lines = [...above, '', top];
  for (const line of content) {
    const padding = Math.max(0, width - 4 - visibleWidth(line));
    lines.push(`${box.v}  ${line}${' '.repeat(padding)}${box.v}`);
  }
  lines.push(`${box.bl}${box.h.repeat(width - 2)}${box.br}`);
  return lines;
}

/** The same question on a terminal that cannot take the panel: plain lines, as before. */
export function plainPrompt(view: PromptView, state: State): string {
  const facts = known(state).map((limit) => `\nspare10 — ${limit}: ${factsLine(state, limit)}`);
  return `${facts.join('') || '\nspare10'}\n${view.headline}\n${view.choices[0].label}? [y/N] `;
}
