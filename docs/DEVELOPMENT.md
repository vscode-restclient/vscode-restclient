# Development guide

How the pieces of this repository fit together, what the battery checks and
why, and what to touch when you change something. It complements
[CONTRIBUTING.md](../CONTRIBUTING.md), which covers PR titles and releases.

## Four products from one source tree

The same `src/` produces four things, and the whole architecture follows from
that:

| Product | Entry point | Built by | Ships as |
| --- | --- | --- | --- |
| The VS Code extension | `src/extension.ts` | webpack (`npm run build`) → `dist/extension.js` | the `.vsix` on the Marketplace and Open VSX |
| The terminal runner | `src/cli/index.ts` | webpack → `dist/cli.js` (bundled, single file) and `tsc -p tsconfig.cli.json` → `dist-cli/` (for the tests) | `npm/` → `@vscode-restclient/cli` on npm, and inside the `.vsix` as `dist/cli.js` |
| The MCP server | `src/cli/mcp.ts` (`restclient mcp --root folder`) | same as the runner | part of the runner; the editor launches it (`src/utils/lmTools.ts`) |
| The GitHub Action | `action.yml` | nothing to build | downloads `restclient.js` from the release |

Everything in `src/core/` and `src/cli/` runs **outside the editor**, in a
plain Node process, in CI and in agents. That gives the one rule that most of
the audit exists to defend:

> **`src/core/`, `src/cli/` and `src/utils/httpClient.ts` never import
> `vscode` at module level.** Not directly and not through anything they
> import. `import type` is fine (it disappears on compile). A lazy
> `require('vscode')` inside a function that only the editor calls is fine
> too; `httpClient.ts` does exactly that to pick the editor's environment.

The runner is also what the editor's *Run all requests*, assertions, `import`
/ `run`, JetBrains environments, SSE and WebSocket use, so the editor and the
terminal cannot drift apart: they execute the same code. `scripts/track-vscode.mjs`
follows every import from a core file and reports the full path to any
`vscode` import, and the audit runs it on each of them. `tsconfig.cli.json`
compiles only `src/cli/**` and `src/core/**`, which is a second fence: a core
file that reaches into `src/controllers/` fails to compile for the runner.

### Map of the repository

```
src/
  extension.ts            activation, commands, providers (editor only)
  controllers/            the editor's request/response controllers (editor only)
  providers/, views/      language features and the response webview (editor only)
  utils/                  shared helpers; httpClient.ts is shared with the runner
  utils/auth/             Basic, Digest, AWS SigV4, Cognito, client certificates
  core/                   sequence, assertions, imports, environments, SSE, WebSocket, JUnit
  cli/                    the runner (index.ts), the MCP server (mcp.ts), a minimal parser and settings
  test/unit/              mocha, plain Node (out-test/)
  test/integration/       mocha inside a real VS Code (@vscode/test-electron)
  test/localServers.ts    HTTP/HTTPS/mTLS test servers shared by both suites
webview/                  the response panel's JavaScript (not type-checked; see the contract below)
scripts/                  audit, e2e tests, notices, l10n check, demo, triage of the original's PRs
docs/                     this file, HTTPKEEPER.md (what the fork adds), triage results
npm/                      package.json of the npm package (just the runner)
action.yml                the GitHub Action
l10n/, package.nls*.json  English and Spanish strings
```

## The battery

`npm run check` is what CI runs, in one command:

| Step | What it proves |
| --- | --- |
| `tsc --noEmit` | the extension compiles |
| `test:unit` | 100 unit tests in plain Node |
| `build:cli` + `test:cli` | the runner compiles on its own and passes its end-to-end test (a real server, a chained `.http`, assertions, exit code) |
| `test:mcp` | the MCP server, driven over stdio the way an agent does |
| `test:l10n` | both languages complete, nothing extra |
| `build` | the production bundles |
| `audit` | 105 checks, listed below |
| `test:vsix` | packages the `.vsix`, installs it in a clean VS Code (in Spanish) and exercises it: the only test that sees what reaches the user |

`npm run test:integration` runs the 53 integration tests inside a real VS Code
against `scripts/test-server.cjs`. It is separate because it takes a few
minutes and needs a display (CI uses `xvfb-run` on Linux). The runner points
the extension's state (`VSC_REST_CLIENT_HOME`) at a folder of the run, so the
suite never touches the real `~/.rest-client`.

CI runs all of that on Ubuntu, Windows and macOS with Node 22. macOS runners
are scarce: a job that shows *cancelled after 15 minutes* without starting
just needs a re-run.

**Before opening a PR**, run the exact sequence CI runs, from clean:

```sh
rm -rf out-test out dist dist-cli
npm ci
npm run build
npm run check
npm run test:integration
git status   # must be empty: the battery regenerates nothing it does not commit
```

Tests are named `P-nn · what it proves`. The number identifies a promise of
the plan, shared by the unit and integration suites; several `it`s may prove
the same promise, and a number is never reused for a different one.

## What the audit enforces

`scripts/audit.mjs` is the written-down version of the promises the project
makes. Every check carries a comment with the incident that motivated it; the
groups are:

- **Identity and credit.** The name is `restclient` under publisher
  `vscode-restclient`, the id the code announces matches the manifest, the
  Marketplace is asked whether the name and display name are free, the README
  names Huachao Mao and links the original repository, the MIT license and the
  2016 copyright notice are verbatim, and the manifest credits the original
  author.
- **Licensing.** `THIRD-PARTY-NOTICES.txt` is regenerated from the real
  production tree (`node scripts/generate-notices.mjs`) and checked with
  `--check`; every production package has a notice; no copyleft or unknown
  license.
- **Privacy.** No telemetry dependency, setting or code.
- **Dependencies.** `npm audit` on production dependencies, with a time limit
  and known exceptions that expire on their own when a fix appears; the
  abandoned packages (`aws-amplify`, `xmldom`) stay out.
- **The core does not depend on the editor.** The rule above, file by file,
  plus: the compiled runner contains no `controllers/`.
- **Resources exist and ship.** Every file the code asks for by path (webview
  css/js, icons) exists and is in the package; every command a document link
  invokes exists.
- **The extension and the webview agree.** The two sides talk over
  `postMessage`, and `webview/main.js` is plain JavaScript nothing
  type-checks. The audit holds a `CONTRACT` of every message and its keys and
  checks both sides textually. A new message means a new line in `CONTRACT`.
- **The components agree on their contracts.** The editor launches the MCP
  server with `mcp --root`; the runner tests read `CLI_PATH` so the audit can
  point them at the published bundle; the test servers and their readers use
  the same JSON key for the port.
- **Public API.** The 20 commands keep the `rest-client.` prefix (the exact
  list is frozen by `commandIds.test.ts`), the agent tools ask for
  confirmation and refuse files outside the workspace, the MCP server does not
  write to disk.
- **Release plumbing.** Every workflow that runs the audit builds first; the
  store tools (`@vscode/vsce`, `ovsx`) are pinned by version wherever `npx`
  invokes them; the npm package has the extension's version and is only the
  runner; the release attaches `restclient.js`.
- **Packaging.** The `.vsix` ships the runner, the notices, both languages and
  the webview resources, and no `src/`, source maps, `docs/`, `scripts/`,
  `npm/` or `action.yml`.
- **Promises are counted, not believed.** The number of tests in
  `docs/HTTPKEEPER.md` and `docs/HTTPKEEPER.es.md` is compared with the `it(`
  calls that exist; "400 packages" and "no telemetry" must still be stated.

### If you change X, the audit expects Y

| You | Then |
| --- | --- |
| add or bump a production dependency | `node scripts/generate-notices.mjs` and commit `THIRD-PARTY-NOTICES.txt` |
| add, rename or remove a command | `package.json`, both `package.nls*.json`, `commandIds.test.ts`, and the count in the audit |
| add or remove a test | the test counts in `README.md`, `docs/HTTPKEEPER.md` and `docs/HTTPKEEPER.es.md` |
| add a `postMessage` between the extension and the webview | a line in `CONTRACT` in `scripts/audit.mjs` |
| add a file the webview or the manifest loads | its path in the resources list, and make sure `.vscodeignore` lets it ship |
| add a user-facing string | `vscode.l10n.t()` in code with both `l10n/bundle*.json`; `%key%` in the manifest with both `package.nls*.json` |
| touch `src/core/`, `src/cli/` or `httpClient.ts` | no `vscode` import; run `node scripts/track-vscode.mjs <file>` |
| invoke `vsce` or `ovsx` in a workflow | pin the version |
| change a setting's default for the runner | `src/cli/minimalSettings.ts`, which deliberately reads nothing from disk |

## Tests

- **Unit** (`src/test/unit/`): parsers, variables, assertions, imports,
  environments, the HTTP client against `localServers.ts`, the MCP server
  over `PassThrough` streams.
- **Integration** (`src/test/integration/suite/`): the extension inside VS
  Code: sending, streaming, assertions, environments, proxies, certificates
  and the frozen command ids. They drive the editor through
  `vscode.commands.executeCommand` and read the response document, so they
  test what the user sees.
- **End-to-end of the runner and the MCP server** (`scripts/test-cli.mjs`,
  `scripts/test-mcp.mjs`): the compiled artefact, as a child process.
- **The installed package** (`scripts/test-vsix.mjs`): catches what only
  shows up after installing (resources the manifest left out, half-renamed
  files).

A fix that a user reported gets a test that fails on the commit before the
fix; the PR says which one.

## Documentation

- `README.md` is the original REST Client reference, kept whole so eight years
  of links and answers keep working, plus what the fork adds at the top. The
  audit checks that it names and links the original.
- `docs/HTTPKEEPER.md` (and `.es.md`) describe what the fork adds, with the
  votes behind each feature. Its figures are checked by the audit.
- `docs/` is excluded from the package; it exists for the repository and the
  GitHub Pages site.
- The `.http` syntax for what the fork adds, in short:
  - `import ./other.http` (bare or quoted path, relative to the file): the
    file's `@variables` and named requests become available.
  - `run #name`: runs the request with that `@name`, from this file or an
    imported one. `run #name (@var = value)` overrides are not supported yet.
  - `# @assert subject operator value` in the request's comments, with subjects
    `status`, `time`, `body`, `body.$.jsonpath`, `header.name` (or
    `headers.name`), `sse.count`, `ws.last`, and operators `==`, `!=`, `<`,
    `>`, `contains`, `matches`, `exists`. Implemented in
    `src/core/assertions.ts` and `src/core/imports.ts`.

## Demo recording

`npm run demo` (Windows only) launches a VS Code with the extension, drives it
through `scripts/demo/script.cjs`, captures the window with `PrintWindow` and
assembles `media/shots/*.png` and the GIF. Nothing in the battery depends on
it.
