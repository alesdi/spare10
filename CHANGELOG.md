# Changelog

All notable changes to spare10 are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **The weekly limit is guarded too.** Claude Code reports the weekly quota alongside the 5-hour
  one, and spare10 now watches both: whichever limit reaches its reserve first stops the agent,
  and every message names which one it was. Each limit has its own consent — resuming past the
  session limit leaves the weekly one armed — and re-arms when its own window resets. A plan that
  does not report the weekly limit is guarded on the session limit alone, as before.
- **`--session-reserve` and `--weekly-reserve`** set one limit's reserve apart from the other.
  They override `--reserve` whatever order the flags come in.
- **`spare10 doctor` reports each limit separately**, with a weekday on resets more than a day
  away.

### Changed

- **The default 10% reserve now applies to the weekly limit as well.** After upgrading, a session
  stops once less than a tenth of the week is left, not only a tenth of the 5-hour window.
  `--reserve` sets both; pass `--weekly-reserve` to keep a different share of the week.

### Fixed

- **The pause panel stays inside its frame at narrow widths.** Long headlines and the plain-text
  key hint used to run past the right border.

## [0.5.0] — 2026-09-23

### Added

- **Background sessions are guarded.** `spare10 claude agents` now protects the whole fleet: the
  agent view hands spare10's settings to every session it dispatches, and each one carries its own
  sensor and gate. A background session runs under Claude Code's daemon rather than under the
  launcher, so there is no process to signal — the gate stops it with `claude stop` instead of
  `SIGTERM`, keeping its conversation.
- **One question for everything stopped in the background.** Nothing is attached to a background
  session to ask on, so spare10 records what it stopped and asks once the wrapper is back in front
  of you: a panel listing every paused session, resuming them all into the reserve on a yes.
- **`spare10 doctor` lists sessions still waiting to be resumed**, with the `claude attach` command
  for each. It looks across every run, not just the latest — the run that stopped a session is
  rarely the one you are standing in afterwards — and skips any session that is running again.
  This is the whole report for `spare10 claude --bg …`, which returns before there is anything to
  ask about — and now says so when it starts.

### Fixed

- **The pause prompt reaches every session under a run, not just the first.** `--pause-prompt` was
  tracked per agent, and every session's main thread reports no agent id, so the first one to trip
  consumed the slot and the rest ran on unwarned. Tracking is now per session *and* agent.
- **A subcommand is no longer treated as a session.** `claude agents` and friends make no tool
  calls and cannot be resumed, so they no longer leave a pid for the gate to find.

## [0.4.0] — 2026-09-23

### Changed

- **Both of spare10's questions are now a panel you answer with the arrow keys.** The
  `Start anyway? [y/N]` and `Resume anyway? [y/N]` lines are replaced by a framed prompt that
  reprints the paused session's own Claude Code header — version, model, effort and directory,
  taken from the status line payload that session sent — over a usage bar and the two options
  with what each one costs. `←`/`→` (or `↑`/`↓`, Tab, `h`/`j`/`k`/`l`) move, Enter confirms,
  `y`/`n` still answer outright, and Escape or Ctrl-C declines. The selection starts on the
  safe option, as `[y/N]` always implied. Terminals that cannot take it — no tty, `TERM=dumb`,
  `NO_COLOR`, a non-UTF-8 locale or a window under 48 columns — get the plain line prompt, and
  an unattended run still proceeds without anyone to answer.

## [0.3.1] — 2026-09-14

### Fixed

- **Upgrading spare10 no longer breaks sessions already running.** The hook commands are
  frozen into the `--settings` handed to Claude Code at launch, but they used to point at the
  installed bundle, so replacing it mid-session made every hook run whatever the new version
  understood — after 0.3.0 dropped the `post` subcommand, sessions started under 0.2.x
  reported a `PostToolUse` "blocking error" on every tool call. Each run now keeps its own
  copy of the bundle it was started with, in its run directory, and the hooks call that.

## [0.3.0] — 2026-09-14

### Changed

- **The hard pause now stops Claude Code and asks in the terminal.** When the reserve is
  reached, the gate sends the Claude Code process `SIGTERM` at the next tool call — between
  operations, with subagents and background tasks going down with it — and spare10 asks
  `Resume anyway? [y/N]` on its own. `y` runs `claude --resume` on the same session with a
  note to carry on; anything else leaves the session saved for later. This replaces the
  permission dialog, which non-interactive modes auto-approved (so spare10 fell back to a
  denial the model could retry around) and which piled up once per subagent. The
  `PostToolUse` hook is gone with it. A session that cannot be resumed — `--no-session-persistence`,
  or a run inside another Claude Code session — is denied rather than stopped.
- `spare10 claude` now asks `Start anyway?` before starting into the reserve even when a
  `--pause-prompt` is set, instead of silently proceeding. Launches without a terminal still
  start without asking.
- Once a `--pause-prompt` has gone out, the status line shows a steady orange `⏸ spare10`
  instead of continuing to pulse `⚠ Pausing at next tool call`.

### Added

- `SPARE10_HOME` relocates spare10's state directory (default `~/.spare10`), for tests and
  CI where earlier runs must not seed a new one.

### Fixed

- `--pause-prompt` is now delivered to every agent in the session — the main thread and each
  subagent, on its own next tool call — instead of once to whichever agent happened to call
  a tool first. Hook context only reaches the calling agent, so a subagent that tripped the
  gate used to receive the instruction while the main thread ran on unconstrained, and vice
  versa. The gate no longer disarms globally after injecting; each agent passes only once it
  has been told.

## [0.2.0] — 2026-09-11

### Changed

- The status line now shows a marker in every breaker state instead of staying empty until
  the reserve is reached: a gray `⧗ spare10` while waiting for the first quota reading, a
  green `● spare10` while the reserve is untouched, and an orange `⨯ spare10` once you have
  consented to eat into it. A non-default reserve is spelled out in each, as `● spare10 (20%)`.
  The pulsing orange `⚠ Pausing at next tool call` is unchanged.

## [0.1.2] — 2026-09-10

### Changed

- The `--pause-prompt` instruction is now framed with its context before being handed to the
  agent: who is asking, the quota facts, and a request to wrap up — so a bare "commit and stop"
  arriving mid-turn is no longer ignored for lack of a source.

### Added

- Documented the Homebrew tap (`brew install alesdi/tap/spare10`).

## [0.1.1] — 2026-09-10

### Fixed

- `spare10 --help` now prints to stdout and exits 0, so `spare10 --help | less` works. Usage
  shown in response to a mistake still goes to stderr and exits 2.

## [0.1.0] — 2026-09-10

Initial release.

### Added

- `spare10` launcher that wraps a Claude Code session with a quota sensor (status line), a
  PreToolUse gate, and a PostToolUse hook.
- Circuit breaker that asks for consent at the first tool call once usage eats into the
  reserve, denies outright in non-interactive permission modes, and re-arms when the 5-hour
  window resets.
- `--reserve` to choose how much of the window to keep back (default 10%).
- `--pause-prompt` to inject a wrap-up instruction instead of asking.
- `--no-badge` and chaining of an existing status line command.
- Pulsing orange status line warning, driven by the sensor's own render cadence.
- Startup seeding from the most recent reading in the same window, closing the gap that let
  the first turn slip past the gate.
- `spare10 doctor` to check the installation and the current run.
- Install script, npm publishing with provenance, and GitHub Releases.

[Unreleased]: https://github.com/alesdi/spare10/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/alesdi/spare10/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/alesdi/spare10/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/alesdi/spare10/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/alesdi/spare10/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/alesdi/spare10/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/alesdi/spare10/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/alesdi/spare10/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alesdi/spare10/releases/tag/v0.1.0
