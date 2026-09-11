# Changelog

All notable changes to spare10 are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/alesdi/spare10/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/alesdi/spare10/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/alesdi/spare10/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/alesdi/spare10/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alesdi/spare10/releases/tag/v0.1.0
