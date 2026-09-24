import { describe, expect, it } from 'vitest';
import {
  MIN_PANEL_WIDTH,
  factsLine,
  headerLines,
  palette,
  panelWidth,
  plainPrompt,
  renderMark,
  renderPanel,
  reserveTag,
  thresholdMarker,
  tildePath,
  usageBar,
  visibleWidth,
  type Caps,
  type PromptView,
} from '../src/panel';
import { stoppedView } from '../src/launch';
import { DEFAULT_CONFIG, DEFAULT_STATE, type SessionInfo, type State, type StoppedSession } from '../src/types';
import { stateWith, type StateOverrides } from './helpers';

const FULL: Caps = { color: true, truecolor: true, unicode: true, columns: 90 };
const PLAIN: Caps = { color: false, truecolor: false, unicode: false, columns: 70 };

const SESSION: SessionInfo = {
  version: '2.1.278',
  model: 'Opus 5 (1M context)',
  effort: 'high',
  cwd: '/Users/me/Developer/spare10',
  fastMode: false,
};

const state = (over: StateOverrides = {}): State =>
  stateWith({ pct: 91, resetsAt: 1_789_041_600, updatedAt: 1_789_020_000, session: SESSION, ...over });

const view: PromptView = {
  session: SESSION,
  headline: 'Reserve reached — the session is paused.',
  body: ['spare10 stopped the agent between tool calls, so nothing is half-written.'],
  choices: [
    { label: 'Resume', hint: 'Picks up exactly where it stopped, for the rest of this window.' },
    { label: 'Stop here', hint: 'Back to the shell.' },
  ],
};

const panel = (caps: Caps, selected = 0, over: StateOverrides = {}) =>
  renderPanel({ view, state: state(over), config: DEFAULT_CONFIG, selected, caps, home: '/Users/me' });

/** The framed card, without the session header standing above it. */
const card = (caps: Caps, selected = 0, over: StateOverrides = {}) => {
  const lines = panel(caps, selected, over);
  const top = lines.findIndex((line) => line.startsWith('╭') || line.startsWith('+'));
  return lines.slice(top);
};

describe('renderPanel', () => {
  it.each([60, 70, 90, 200])('draws every card line to the same width at %i columns', (columns) => {
    const widths = new Set(card({ ...FULL, columns }).map(visibleWidth));
    expect([...widths]).toHaveLength(1);
  });

  it('stands the session header above the card, unboxed, with a blank line between', () => {
    const lines = panel(FULL);
    const top = lines.findIndex((line) => line.startsWith('╭'));
    expect(top).toBe(4); // three header rows and the blank line
    expect(lines.slice(0, 3).join('\n')).toContain('Claude Code');
    expect(lines[3]).toBe('');
    expect(lines.slice(0, 4).some((line) => line.includes('│'))).toBe(false);
  });

  it('keeps the same height whichever option is selected, so redrawing does not jump', () => {
    expect(panel(FULL, 0)).toHaveLength(panel(FULL, 1).length);
  });

  it('never exceeds the terminal width', () => {
    for (const columns of [50, 64, 80, 120]) {
      for (const line of panel({ ...FULL, columns })) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
      }
    }
  });

  it('marks the selected option and only shows its hint', () => {
    const resume = panel(FULL, 0).join('\n');
    const stop = panel(FULL, 1).join('\n');
    expect(resume).toContain('Picks up exactly where it stopped');
    expect(resume).not.toContain('Back to the shell.');
    expect(stop).toContain('Back to the shell.');
  });

  it('falls back to ASCII and no colour when the terminal cannot do better', () => {
    const drawn = panel(PLAIN).join('\n');
    expect(drawn).not.toMatch(/\u001b\[/);
    expect(drawn).not.toMatch(/[╭╮╰╯│─█▒▀▄]/);
  });

  it('shows the paused session header', () => {
    const drawn = panel(FULL).join('\n');
    expect(drawn).toContain('Claude Code');
    expect(drawn).toContain('v2.1.278');
    expect(drawn).toContain('Opus 5 (1M context) with high effort');
    expect(drawn).toContain('~/Developer/spare10');
  });

  it('draws a labelled bar for each limit it knows', () => {
    const drawn = card(PLAIN, 0, { weekly: { pct: 64, resetsAt: 1_789_257_600, updatedAt: 1_789_020_000 } });
    expect(drawn.some((line) => /session +#+-* +91% used/.test(line))).toBe(true);
    expect(drawn.some((line) => /weekly +#+-* +64% used/.test(line))).toBe(true);
  });

  it('leaves out a limit the plan does not report', () => {
    expect(card(PLAIN).join('\n')).not.toContain('weekly');
  });

  it('stays inside its frame at the narrowest width, whatever it has to drop', () => {
    const narrow: Caps = { ...PLAIN, columns: MIN_PANEL_WIDTH };
    const lines = card(narrow, 0, { weekly: { pct: 93, resetsAt: 1_789_257_600, updatedAt: 1_789_020_000 } });
    const width = visibleWidth(lines[0] as string);
    for (const line of lines) expect(visibleWidth(line)).toBe(width);
  });

  it('drops the usage bar rather than inventing a figure when the quota is unknown', () => {
    const drawn = panel(FULL, 0, { pct: null }).join('\n');
    expect(drawn).not.toContain('% used');
    expect(drawn).toContain('Reserve reached');
  });
});

describe('headerLines', () => {
  it('leaves out what the payload did not carry', () => {
    const p = palette(PLAIN);
    const lines = headerLines({ ...SESSION, model: null, effort: null, version: null }, '/Users/me', p);
    expect(lines).toEqual(['Claude Code', '~/Developer/spare10']);
  });

  it('is one line when nothing is known at all', () => {
    expect(headerLines(null, '/Users/me', palette(PLAIN))).toEqual(['Claude Code']);
  });

  it('names fast mode, which changes what a session costs', () => {
    const lines = headerLines({ ...SESSION, fastMode: true }, '/Users/me', palette(PLAIN));
    expect(lines[1]).toContain('fast mode');
  });
});

describe('renderMark', () => {
  it('is three rows of equal width, to sit beside the three header lines', () => {
    const rows = renderMark(FULL);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(visibleWidth))).toEqual(new Set([9]));
  });

  it('is left out entirely when the terminal cannot colour it', () => {
    expect(renderMark(PLAIN)).toEqual([]);
  });
});

describe('thresholdMarker', () => {
  it('points at the first cell of the reserve', () => {
    const p = palette(PLAIN);
    expect(thresholdMarker(90, 20, p, false, 'up')).toBe(`${' '.repeat(18)}^`);
    expect(thresholdMarker(50, 10, p, true, 'down')).toBe(`${' '.repeat(5)}▼`);
  });

  it('never points past the end of the bar', () => {
    expect(thresholdMarker(100, 10, palette(PLAIN), false, 'up')).toBe(`${' '.repeat(9)}^`);
  });
});

describe('threshold arrows in the panel', () => {
  const weekly = { weekly: { pct: 64, resetsAt: 1_789_257_600, updatedAt: 1_789_020_000 } };
  const arrows = (lines: string[]) => lines.filter((line) => /^\|\s+[v^]\s+\|$/.test(line));
  /** Where the arrow is, and where the bar next to it starts, counted in columns. */
  const offset = (line: string, glyph: string) => line.indexOf(glyph);

  it('marks the threshold above the top bar and below the bottom one', () => {
    const lines = card(PLAIN, 0, weekly);
    const [down, up] = arrows(lines);
    const top = lines.findIndex((line) => line.includes('session  '));
    expect(lines[top - 1]).toBe(down);
    expect(lines[top + 2]).toBe(up);
    expect(offset(down as string, 'v')).toBe(offset(up as string, '^'));
  });

  it('marks each bar at its own threshold when the reserves differ', () => {
    const config = { ...DEFAULT_CONFIG, reserve: { session: 50, weekly: 10 } };
    const lines = renderPanel({ view, state: state(weekly), config, selected: 0, caps: PLAIN, home: '/Users/me' });
    const down = lines.find((line) => /^\|\s+v\s+\|$/.test(line)) as string;
    const up = lines.find((line) => /^\|\s+\^\s+\|$/.test(line)) as string;
    expect(offset(down, 'v')).toBeLessThan(offset(up, '^'));
  });

  it('draws no arrows when the panel is too narrow for bars', () => {
    const narrow: Caps = { ...PLAIN, columns: MIN_PANEL_WIDTH };
    expect(arrows(card(narrow, 0, { weekly: { ...weekly.weekly, pct: 93 } }))).toEqual([]);
  });
});

describe('usageBar', () => {
  it('draws only a limit into its reserve in the brand colour', () => {
    const p = palette(FULL);
    const brand = '\u001b[38;2;217;119;87m';
    expect(usageBar(50, 10, p, true, true)).toContain(brand);
    expect(usageBar(50, 10, p, true, false)).not.toContain(brand);
  });

  it('colours the limit that tripped and leaves the other gray', () => {
    const brand = '\u001b[38;2;217;119;87m';
    const lines = card(FULL, 0, { pct: 40, weekly: { pct: 95, resetsAt: 1_789_257_600, updatedAt: 1_789_020_000 } });
    // eslint-disable-next-line no-control-regex
    const row = (label: string) => lines.find((line) => line.replace(/\u001b\[[0-9;]*m/g, '').includes(`${label}  `));
    expect(row('weekly')).toContain(brand);
    expect(row('session')).toBeDefined();
    expect(row('session')).not.toContain(brand);
  });

  it('fills in proportion to usage', () => {
    const p = palette(PLAIN);
    expect(usageBar(50, 10, p, false)).toBe('#####-----');
    expect(usageBar(0, 10, p, false)).toBe('----------');
    expect(usageBar(100, 10, p, false)).toBe('##########');
  });
});

describe('tildePath', () => {
  it.each([
    ['/Users/me/src/x', '/Users/me', '~/src/x'],
    ['/Users/me', '/Users/me', '~'],
    ['/opt/thing', '/Users/me', '/opt/thing'],
    ['/Users/median/x', '/Users/me', '/Users/median/x'],
  ])('%s under %s reads as %s', (path, home, expected) => {
    expect(tildePath(path, home)).toBe(expected);
  });
});

describe('factsLine', () => {
  it('says so plainly when there is no reading', () => {
    expect(factsLine({ ...DEFAULT_STATE }, 'session')).toContain('quota unknown');
  });

  it('leads with what is left', () => {
    expect(factsLine(state(), 'session')).toMatch(/^91% used · 9% left · resets /);
  });

  it('drops the used figure when asked to be short', () => {
    expect(factsLine(state(), 'session', true)).toMatch(/^9% left · resets /);
  });
});

describe('reserveTag', () => {
  it('names one figure when both limits share it', () => {
    expect(reserveTag(DEFAULT_CONFIG)).toBe('10% reserve');
  });

  it('gives both, in limit order, when they differ', () => {
    expect(reserveTag({ ...DEFAULT_CONFIG, reserve: { session: 20, weekly: 5 } })).toBe('20% · 5% reserve');
  });
});

describe('plainPrompt', () => {
  it('still carries the figures for terminals that get no panel', () => {
    const prompt = plainPrompt(view, state());
    expect(prompt).toContain('91% used');
    expect(prompt).toContain('Resume? [y/N]');
  });
});

describe('panelWidth', () => {
  it('never goes below the minimum or past the maximum', () => {
    expect(panelWidth(20)).toBe(MIN_PANEL_WIDTH);
    expect(panelWidth(400)).toBe(78);
  });
});

describe('the stopped-background panel', () => {
  const records: StoppedSession[] = [
    { sessionId: 's1', backgroundId: 'be4ca65c', name: 'nightly refactor', cwd: '/Users/me/Developer/spare10', at: 1 },
    { sessionId: 's2', backgroundId: '206672f0', name: 'docs sweep', cwd: '/Users/me/Developer/other', at: 2 },
  ];

  const stopped = (caps: Caps, selected = 0) => {
    const lines = renderPanel({
      view: stoppedView(records, state(), ['session'], '/Users/me'),
      state: state(),
      config: DEFAULT_CONFIG,
      selected,
      caps,
      home: '/Users/me',
    });
    const top = lines.findIndex((line) => line.startsWith('╭') || line.startsWith('+'));
    return lines.slice(top);
  };

  it('gives each stopped session its own line', () => {
    const text = stopped(FULL).join('\n');
    expect(text).toContain('nightly refactor · ~/Developer/spare10');
    expect(text).toContain('docs sweep · ~/Developer/other');
  });

  it('keeps its height as the selection moves', () => {
    expect(stopped(FULL, 0)).toHaveLength(stopped(FULL, 1).length);
  });

  it('draws every card line to the same width', () => {
    expect([...new Set(stopped(FULL).map(visibleWidth))]).toHaveLength(1);
  });

  it('survives a terminal with no colour and no unicode', () => {
    expect(stopped(PLAIN).join('\n')).toContain('nightly refactor');
  });
});
