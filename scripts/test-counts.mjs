// The number of tests the docs state, and the number there are.
//
// A pull request that adds a test does not touch the docs: the audit only
// checks that they never promise more tests than exist (a floor), and the
// release-please workflow runs this script on the release PR, so every
// released version states the exact count next to its changelog.
//
// In the docs, each number is wrapped in a tag, and the words around it are
// free (and translated):
//
//   <!-- tests:total -->193<!-- /tests --> tests, <!-- tests:unit -->124<!-- /tests --> unit
//
// The kinds are `total`, `unit` and `integration`. The tags are HTML comments:
// GitHub, the Marketplace and the editor's preview do not show them.
//
//   node scripts/test-counts.mjs           rewrite the tagged numbers
//   node scripts/test-counts.mjs --check   exit 1 if any of them is not exact
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

/** Documents that must state the number of tests (at least the total). */
export const FILES = ['README.md', 'docs/HTTPKEEPER.md', 'docs/HTTPKEEPER.es.md'];

const TAG = /<!-- tests:(total|unit|integration) -->(\d+)<!-- \/tests -->/g;

const countIts = (dir) => fs.readdirSync(path.join(root, dir), { recursive: true })
  .filter((f) => String(f).endsWith('.test.ts'))
  .reduce((n, f) => n + (read(path.join(dir, String(f))).match(/\bit\(/g)?.length ?? 0), 0);

/** The `it(` calls written in the unit and integration suites. */
export function countTests() {
  const unit = countIts('src/test/unit');
  const integration = countIts('src/test/integration');
  return { total: unit + integration, unit, integration };
}

/** Every tagged number in a document: [{ kind, stated }]. */
export function readClaims(file) {
  return [...read(file).matchAll(TAG)].map((m) => ({ kind: m[1], stated: Number(m[2]) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const actual = countTests();
  let bad = 0;
  for (const file of FILES) {
    const claims = readClaims(file);
    if (!claims.some((c) => c.kind === 'total')) {
      console.error(`${file}: no <!-- tests:total --> tag`);
      bad++;
      continue;
    }
    const wrong = claims.filter((c) => c.stated !== actual[c.kind]);
    if (wrong.length === 0) {
      console.log(`${file}: already exact`);
    } else if (check) {
      for (const c of wrong) {
        console.error(`${file}: ${c.kind} says ${c.stated}, there are ${actual[c.kind]}`);
      }
      bad++;
    } else {
      fs.writeFileSync(path.join(root, file),
        read(file).replace(TAG, (_, kind) => `<!-- tests:${kind} -->${actual[kind]}<!-- /tests -->`));
      console.log(`${file}: ${wrong.map((c) => `${c.kind} ${c.stated} → ${actual[c.kind]}`).join(', ')}`);
    }
  }
  process.exit(bad ? 1 : 0);
}
