# spare10

**A circuit breaker for Claude Code.** It keeps a slice of your 5-hour quota in reserve and
stops the agent before that reserve is spent — so you still have budget left to steer it,
instead of the session dying mid-edit.

```
spare10 claude
```

That's the whole integration. spare10 configures the session and gets out of the way.

---

## The problem

A long autonomous session burns quota invisibly. When it hits 100%, Claude Code stops
immediately: a half-finished refactor, uncommitted, and no agent available to finish it or
back it out. Your context isn't lost — `claude --continue` restores it — but the hours until
the window resets are, and so is any chance to say "wait, commit that first."

spare10 spends the last slice of your quota on **you**.

## What it does

When usage starts eating the reserve (the last 10% by default) it hands control back:

```
spare10 — 9% of the 5-hour window left, which is your 10% reserve.
Resets at 14:00. Continue anyway?
  ❯ Yes    No (Esc)
```

Approve and it stays quiet for the rest of the window. Press Esc and the turn ends there,
with your working tree in a state you chose.

For unattended runs, hand it an instruction instead of a question:

```bash
spare10 --pause-prompt "Finish this block, commit, then stop." claude
```

That text is injected into the running agent **without blocking it**, so the agent can
actually carry out the wind-down you asked for.

## Install

> **Node.js 20+ is required on every install path**, including Homebrew and the install
> script. spare10 is a Node program; brew and curl are conveniences for fetching it, not a way
> to avoid the runtime. Bundling one would cost 60–110 MB and make the hot path slower.

```bash
npm install -g spare10        # or: npx spare10 claude
brew install alesdi/tap/spare10
curl -fsSL https://raw.githubusercontent.com/alesdi/spare10/main/install.sh | sh
```

## Usage

```
spare10 [options] <command> [args...]

  --reserve <1-99>       Keep this much of the 5-hour window back for yourself (default: 10)
  --pause-prompt <text>  Inject this instruction instead of asking
  --refresh <seconds>    Quota poll interval (default: 2)
  --no-badge             Never draw the spare10 marker in the status line
  doctor                 Report what spare10 detected and what it would do
```

Everything after the command passes through untouched, so `spare10 claude --resume` works as
you'd expect.

`--reserve` is the quota you keep, not the level that trips — `--reserve 20` stops the agent
with a fifth of the window still in hand. It takes whole numbers only: Claude Code reports
quota in integer percentages, so `--reserve 10.5` is rejected rather than silently rounded.

The status line shows nothing until the reserve is reached, then a blinking
`⚠ Pausing at next tool call`. Once you have consented it drops back to a quiet `▶ spare10`,
with a non-default reserve spelled out as `▶ spare10 (20%)` — the name already accounts for 10.

Consenting at the pre-flight prompt counts for the whole window: the session starts disarmed
rather than asking the same question again on the first tool call.

## How it works

Claude Code exposes quota in exactly one place: the `rate_limits` object handed to your
**status line** command. It is not available to hooks. Hooks, meanwhile, are the only thing
that can *stop* anything. So spare10 splits in two and joins them through a state file:

```
spare10 claude
  └─ exec claude --settings '{ statusLine: …, hooks: { PreToolUse: …, PostToolUse: … } }'

  sensor   (status line, every 2s)   reads rate_limits → writes state
  gate     (PreToolUse, every call)  reads state → passes, asks, injects, or denies
  post     (PostToolUse)             the tool ran, so the user approved → disarm
```

**It stops between operations, not mid-write.** The gate fires on tool calls, and that is the
point rather than a limitation: it interrupts in the gap between one call and the next, where
nothing is half-written and no command is in flight. A keystroke-level interrupt would land
wherever the agent happened to be — which is the mess spare10 exists to avoid.

The cost is that a turn producing only text is not gated. Before launching, spare10 already
knows your quota from the previous run, so `spare10 claude` asks for confirmation rather than
starting a session that would stop on its first move. Once a session is running, the status
line badge is the signal — a hook's only user-visible channel is exit code 2, which on
`UserPromptSubmit` erases what you typed, and plain output there becomes model context that
Claude paraphrases rather than a message you can rely on.

Three consequences worth knowing:

**Nothing you own is modified.** `claude --settings` accepts a raw JSON string, so a run
configures exactly one session. No file in `~/.claude` is touched. Close the terminal and
spare10 is gone.

**Your existing setup keeps working.** Hooks merge across settings levels, so your own hooks
still fire. The status line does *not* merge — ours replaces it — so spare10 runs your
original status line command with the untouched payload and prints its output. If you have
none, spare10 draws nothing at all until the reserve is reached.

**It knows the quota from the first tool call.** Claude Code omits `rate_limits` from the
first status line payload of every session, so a fresh run is briefly blind — long enough for
the opening turn to slip past. spare10 opens each run with the most recent reading from the
previous run in the same window. Quota is account-wide and only rises within a window, so that
figure is a lower bound: it can bring a stop forward, never invent one. Only the very first run
of a window starts with nothing.

**It fails open, always.** No reading, a stale reading, a plan that doesn't report
`rate_limits`, a corrupt state file, a missing run directory — every one of those lets the
tool call through. A quota guard that blocks your session because it went blind is worse than
no guard. When it can't see quota for three consecutive polls it says so in the status line.

Run `spare10 doctor` to see exactly what it detected.

## What it doesn't do

Not in this version, deliberately:

- **Headless / `-p` mode.** No status line renders, so there's no sensor. spare10 does nothing.
- **The weekly limit.** Only the 5-hour window is watched.
- **Auto-resume** when the window resets.
- **Model downgrade** (Opus → Sonnet) as an alternative to stopping.
- **Overshoot correction.** The reserve is indicative, not predictive: readings land at 1%
  granularity and up to one refresh interval late, and parallel subagents can land several
  requests at once. Keep back more than you think you need.
- **Coordination across sessions.** Quota is account-wide, but each run tracks its own state.

## Known limitations

- In `bypassPermissions` and `dontAsk` modes an `ask` dialog would be auto-approved, so
  spare10 falls back to `deny`. The agent may then retry with a different tool and be denied
  again, burning tokens in a small loop. The deny message tells it to stop; there is no retry
  counter yet.
- Status line chaining reads user-level settings only. A status line configured in project or
  local settings is not detected.

## Development

```bash
npm install
npm test          # 119 tests: unit, plus the hooks as real subprocesses
npm run typecheck
npm run build     # single dependency-free bundle in dist/
```

Test fixtures are real payloads captured from a live Claude Code session, sanitized. When
Anthropic changes the status line schema, the tolerant parser keeps spare10 failing open and
`doctor` reports the drift.

## License

MIT
