# Changelog

All notable changes to spare10 are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/alesdi/spare10/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/alesdi/spare10/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/alesdi/spare10/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/alesdi/spare10/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/alesdi/spare10/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alesdi/spare10/releases/tag/v0.1.0
