# Contributing

## Releases and PR titles

Versioning, the changelog and releases are handled by
[release-please](https://github.com/googleapis/release-please): on every push to
`master` it maintains a *release PR*; merging that PR creates the tag and the
GitHub release, and the same workflow publishes to the Marketplace and Open VSX.

Two things make that work:

1. **Squash-merge pull requests**, so each PR lands as one commit.
2. **Give PRs a [Conventional Commits](https://www.conventionalcommits.org) title** —
   it becomes the commit, and the commits become the changelog:
   - `feat: …` → new feature (minor bump)
   - `fix: …` → bug fix (patch bump)
   - `feat!: …` or a `BREAKING CHANGE:` footer → major bump
   - `chore:`/`docs:`/`test:`/`ci:` → no release, not in the changelog

Write the title for the person reading the changelog, not for the reviewer:
"fix: basic auth truncated passwords containing spaces" beats "fix bug".

## Quality bar

Every PR must keep the battery green: `npm run audit` (≈80 checks: identity,
licensing, privacy, packaging, e2e of the runner and the MCP server) plus the
unit and integration suites (`npm test`). CI runs all of it on the three
platforms; running it locally first saves everyone a round trip. If you add a
production dependency, regenerate the third-party notices with
`node scripts/generar-notices.mjs` — the audit fails if you forget.
