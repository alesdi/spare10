/**
 * What the pause prompt looks like at 91% of the window with a 10% reserve.
 *
 * Run through `scripts/demo.mjs`, which bundles this against the real `src/` — so what you see
 * is the panel spare10 would actually draw, not a mock-up that can drift away from it.
 */

import { renderPanel, plainPrompt, type Caps, type PromptView } from '../src/panel';
import { ask } from '../src/terminal';
import { DEFAULT_STATE, type RunConfig, type State } from '../src/types';

const USED = 91;
const RESERVE = 10;

const config: RunConfig = { reserve: RESERVE, pausePrompt: null, refresh: 2, badge: true, chain: null };

const now = Math.floor(Date.now() / 1000);
const state: State = {
  ...DEFAULT_STATE,
  pct: USED,
  // A five-hour window that started three hours and ten minutes ago.
  resetsAt: now + 110 * 60,
  updatedAt: now - 3,
  halted: '4f3c1a92-7e20-4d51-9a6b-1c8e5f0d2b77',
  session: {
    version: '2.1.278',
    model: 'Opus 5 (1M context)',
    effort: 'high',
    cwd: process.cwd(),
    fastMode: false,
  },
};

// Kept in step with `haltView`/`preflightView` in src/launch.ts by hand.
const haltView: PromptView = {
  session: state.session,
  headline: 'Reserve reached. The session is paused.',
  body: [
    'spare10 stopped the agent between tool calls, so nothing is half-written and the whole ' +
      'conversation is saved.',
  ],
  choices: [
    { label: 'Resume', hint: 'Continue on the reserve. spare10 stays quiet until the limit resets.' },
    {
      label: 'Stop here',
      hint: `Back to the shell. You can still resume later with: claude --resume ${state.halted}`,
    },
  ],
};

const preflightView: PromptView = {
  session: { version: null, model: null, effort: null, cwd: process.cwd(), fastMode: false },
  headline: 'This session would start inside the reserve.',
  body: [
    `You have less than the ${RESERVE}% reserve left for this session. If you decide to start ` +
      `anyway, spare10 will stay quiet until the limit resets.`,
  ],
  choices: [
    { label: 'Start anyway', hint: 'Runs now on your reserve.' },
    { label: 'Do not start', hint: 'Back to the shell.' },
  ],
};

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const value = (flag: string): number | null => {
  const index = argv.indexOf(flag);
  const raw = index === -1 ? null : argv[index + 1];
  return raw !== null && raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
};

const view = has('--preflight') ? preflightView : haltView;
const columns = value('--width') ?? process.stdout.columns ?? 80;

const caps = (over: Partial<Caps> = {}): Caps => ({
  color: true,
  truecolor: /truecolor|24bit/i.test(process.env['COLORTERM'] ?? ''),
  unicode: true,
  columns,
  ...over,
});

const draw = (label: string, selected: number, shown: Caps) => {
  const panel = renderPanel({ view, state, config, selected, caps: shown, home: process.env['HOME'] ?? '' });
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
