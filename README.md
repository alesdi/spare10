# spare10

**A circuit breaker for Claude Code.** Use spare10 when you run low-priority agents on Claude Code and you want to keep a reserve of quota for important stuff. Spare10 watches your session limits and stops the agent when you reach 90%. Then it's up to you to decide whether to continue or not.

To launch a session with spare10, just prefix the `claude` command with `spare10`:

```
spare10 claude
```

## How it works

When usage starts eating the reserve (the last 10% by default) it stops Claude Code at the
agent's next tool call — the whole process, subagents and background tasks included — and asks
you in the terminal whether to carry on:

<img width="1080" height="525" alt="spare10" src="https://github.com/user-attachments/assets/7e0107b1-a389-44dd-b5cc-638b6837cf88" />

The header above the card is the paused session's own — version, model, effort level and
directory as that session reported them in the status line payload it was sending spare10 all
along, not the installed version or the default model. It stands outside the frame because it
describes the session, not the question.

`←`/`→` move between the options and Enter confirms; `y` and `n` still answer outright, and
Escape leaves the session alone. The selection starts on *Stop here*, so a stray Enter never
spends the reserve.

Choose **Resume** and the session picks up right where it stopped, with its whole conversation,
and spare10 stays quiet until the limit resets. Choose **Stop here** and you are back at your
shell with the session saved; `claude --resume <id>` picks it up later, when the window has
reset. Terminals that cannot draw the panel — a pipe, `TERM=dumb`, `NO_COLOR`, a narrow
window — get the plain one-line question instead, and a run with nobody attached carries on
rather than waiting for an answer that cannot come.

For unattended runs, hand it an instruction instead of a question:

```bash
spare10 --pause-prompt "Finish this block, commit, then stop." claude
```

That text is injected into the running agent **without blocking it**, so the agent can
actually carry out the wind-down you asked for. Every agent gets it — the main thread and each
subagent, on its own next tool call — because hook context only reaches the agent whose call
it rode in on, and a subagent left untold would keep working. It arrives with the situation
attached, since an instruction turning up mid-turn otherwise has no context:

```
spare10 budget guard. You have reached the safe usage limit for this session
(into your 10% reserve · 9% of quota left · resets 14:00). Wrap up your work and stop.

User instructions: Finish this block, commit, then stop.
```

## Install

> **Node.js 20+ is required on every install path**, including Homebrew and the install
> script. spare10 is a Node program; brew and curl are conveniences for fetching it, not a way
> to avoid the runtime. Bundling one would cost 60–110 MB and make the hot path slower.

```bash
npm install -g spare10        # or, with no install at all: npx spare10 claude
brew install alesdi/tap/spare10
curl -fsSL https://raw.githubusercontent.com/alesdi/spare10/main/install.sh | sh
```

The install script fetches the same published bundle and puts `spare10` in
`~/.local/bin`. It checks for Node 20+ first and tells you plainly if it is missing, rather
than installing something that cannot run.

## Usage

```
spare10 [options] <command> [args...]

  --reserve <1-99>       Keep this much of the 5-hour window back for yourself (default: 10)
  --pause-prompt <text>  Inject this instruction instead of stopping
  --refresh <seconds>    Quota poll interval (default: 2)
  --no-badge             Never draw the spare10 marker in the status line
  doctor                 Report what spare10 detected and what it would do
```

Everything after the command passes through untouched, so `spare10 claude --resume` works as
you'd expect.

`--reserve` is the quota you keep, not the level that trips — `--reserve 20` stops the agent
with a fifth of the window still in hand. It takes whole numbers only: Claude Code reports
quota in integer percentages, so `--reserve 10.5` is rejected rather than silently rounded.

The status line shows a gray `⧗ spare10` until the first quota reading arrives, a green
`● spare10` while the reserve is untouched, then an orange
`⚠ Pausing at next tool call` once it is reached, its icon pulsing once per refresh. Once you
have consented it drops back to a quiet orange `⨯ spare10`; once a `--pause-prompt` has gone
out it shows `⏸ spare10`. A non-default reserve is spelled out either way, as
`● spare10 (20%)` — the name already accounts for 10.

The pulse is driven by spare10's own render cadence rather than the ANSI blink attribute,
which most terminals ignore.

Consenting at the pre-flight prompt counts for the whole window: the session starts disarmed
rather than stopping again on the first tool call.

State lives under `~/.spare10`; set `SPARE10_HOME` to put it somewhere else.

## Under the hood

Claude Code exposes quota in exactly one place: the `rate_limits` object handed to your
**status line** command. It is not available to hooks. Hooks, meanwhile, are the only thing
that can *stop* anything. So spare10 splits in two and joins them through a state file:

```
spare10 claude
  └─ spawn claude --settings '{ statusLine: …, hooks: { PreToolUse: … } }'

  sensor    (status line, every 2s)   reads rate_limits → writes state
  gate      (PreToolUse, every call)  reads state → passes, injects, or stops Claude Code
  launcher  (after Claude Code exits) sees the stop → asks → claude --resume <session>
```

**It stops between operations, not mid-write.** The gate fires on tool calls, and that is the
point rather than a limitation: it interrupts in the gap between one call and the next, where
nothing is half-written and no command is in flight. Claude Code runs write-capable tools one
at a time, so when the gate fires nothing else that writes can be running either. A
keystroke-level interrupt would land wherever the agent happened to be — which is the mess
spare10 exists to avoid.

**It stops the process, not the turn.** A hook on its own can only deny a tool call or ask
through Claude Code's permission dialog — which non-interactive modes auto-approve, and which
the model can keep retrying around. So the gate sends Claude Code `SIGTERM` instead. Claude
Code exits cleanly, the transcript is already on disk, and spare10 asks its own question on
the terminal it now owns; `y` starts `claude --resume` on the same session. The question is the
same one in every permission mode, and subagents go down with the process rather than each
raising a dialog of their own.

The cost is that a turn producing only text is not gated. Before launching, spare10 already
knows your quota from the previous run, so `spare10 claude` asks for confirmation rather than
starting a session that would stop on its first move.

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

- Stopping the process drops what only lived in it: permissions granted for the session,
  anything queued or half-typed in the prompt. The resumed session asks again.
- A session that cannot be resumed — started with `--no-session-persistence`, or inside
  another Claude Code session, where transcripts are not saved — is not stopped. The gate
  denies the tool call instead, and the model may retry with another tool before it gives up.
- Status line chaining reads user-level settings only. A status line configured in project or
  local settings is not detected.

## Development

```bash
npm install
npm test          # 213 tests: unit, plus the hooks and CLI as real subprocesses
npm run typecheck
npm run build     # single dependency-free bundle in dist/
npm run demo      # the pause prompt at 91% usage, without burning a session
```

`npm run demo` draws the real panel from `src/`, so it cannot drift from what spare10 shows.
It is interactive by default; `-- --static` prints every state at once (both selections, the
no-colour fallback and the plain line prompt), `-- --preflight` shows the question asked
before launch rather than the one after a stop, and `-- --width 64` forces a narrower
terminal.

Test fixtures are real payloads captured from a live Claude Code session, sanitized. When
Anthropic changes the status line schema, the tolerant parser keeps spare10 failing open and
`doctor` reports the drift.

## License

MIT
