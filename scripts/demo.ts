/**
 * What the pause prompt looks like at 91% of the session limit with a 10% reserve — or, with
 * `--weekly`, at 93% of the weekly one.
 *
 * Run through `scripts/demo.mjs`, which bundles this against the real `src/` — so what you see
 * is the panel spare10 would actually draw, not a mock-up that can drift away from it.
 */

import { haltView, preflightView } from '../src/launch';
import { renderPanel, plainPrompt, type Caps, type PromptView } from '../src/panel';
import { ask } from '../src/terminal';
import { DEFAULT_CONFIG, DEFAULT_STATE, EMPTY_LIMIT, type Limit, type State } from '../src/types';

const config = DEFAULT_CONFIG;
const now = Math.floor(Date.now() / 1000);

/** A session window that started three hours ten minutes ago, and a week two days from its end. */
function scenario(sessionPct: number, weeklyPct: number): State {
  return {
    ...DEFAULT_STATE,
    limits: {
      session: { ...EMPTY_LIMIT, pct: sessionPct, resetsAt: now + 110 * 60, updatedAt: now - 3 },
      weekly: { ...EMPTY_LIMIT, pct: weeklyPct, resetsAt: now + 2 * 86400 + 5 * 3600, updatedAt: now - 3 },
    },
    halted: '4f3c1a92-7e20-4d51-9a6b-1c8e5f0d2b77',
    session: {
      version: '2.1.278',
      model: 'Opus 5 (1M context)',
      effort: 'high',
      cwd: process.cwd(),
      fastMode: false,
    },
  };
}

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const value = (flag: string): number | null => {
  const index = argv.indexOf(flag);
  const raw = index === -1 ? null : argv[index + 1];
  return raw !== null && raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
};

const weekly = has('--weekly');
const state = weekly ? scenario(41, 93) : scenario(91, 64);
const limits: Limit[] = weekly ? ['weekly'] : ['session'];
const view: PromptView = has('--preflight')
  ? preflightView(state, config, limits)
  : haltView(state, limits);
const columns = value('--width') ?? process.stdout.columns ?? 80;

const caps = (over: Partial<Caps> = {}): Caps => ({
  color: true,
  truecolor: /truecolor|24bit/i.test(process.env['COLORTERM'] ?? ''),
  unicode: true,
  columns,
  ...over,
});

const draw = (label: string, selected: number, shown: Caps, drawn = view, at = state) => {
  const panel = renderPanel({
    view: drawn,
    state: at,
    config,
    selected,
    caps: shown,
    home: process.env['HOME'] ?? '',
  });
  process.stdout.write(`\n\u001b[38;5;245m${label}\u001b[39m\n${panel.join('\n')}\n`);
};

const still = () => {
  draw(`${view.choices[1].label} selected — where the panel opens`, 1, caps());
  draw(`${view.choices[0].label} selected — after one press of ←`, 0, caps());
  draw(
    'Without colour or block characters (TERM=dumb, NO_COLOR, a non-UTF-8 locale)',
    1,
    caps({ color: false, unicode: false }),
  );
  if (!weekly) {
    const both = scenario(93, 95);
    draw(
      'Both limits into their reserve at once (--weekly shows the weekly limit alone)',
      1,
      caps(),
      haltView(both, ['session', 'weekly']),
      both,
    );
  }
  process.stdout.write('\n\u001b[38;5;245mWith no terminal at all (a pipe, or a narrow window)\u001b[39m');
  process.stdout.write(`${plainPrompt(view, state)}\n\n`);
};

if (has('--static') || !process.stdout.isTTY) {
  still();
} else {
  process.stdout.write(
    '\n\u001b[38;5;245mThe real prompt. Arrow keys to move, enter to confirm, esc to cancel. ' +
      'Add --static to print every state instead.\u001b[39m\n',
  );
  const answer = await ask({ view, state, config });
  const chosen = answer === null ? 'nobody was there to answer' : `"${answer}"`;
  process.stdout.write(`\nspare10 would act on: ${chosen}\n`);
}
