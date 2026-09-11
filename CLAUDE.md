# spare10

Circuit breaker for Claude Code: pauses autonomous sessions before the 5-hour quota runs out.
TypeScript, bundled to `dist/spare10.js`. `npm test` (vitest), `npm run typecheck`, `npm run build`.

## Releasing

Everything lands on `main` directly; a release is a version bump plus a tag.

1. Move the entries under `## [Unreleased]` in `CHANGELOG.md` into a new `## [x.y.z] — YYYY-MM-DD`
   section, leave `[Unreleased]` empty, and update the compare links at the bottom.
2. `npm version <patch|minor|major> --no-git-tag-version`, then commit `package.json`,
   `package-lock.json` and `CHANGELOG.md` together as `Release x.y.z`.
3. `git tag -a vx.y.z -m "spare10 x.y.z — <one-line summary>"` and `git push --follow-tags`.
4. The Release workflow publishes to npm and creates the GitHub release, using the matching
   `CHANGELOG.md` section as the release body.

Every user-facing change should add a line under `[Unreleased]` in the same commit.
