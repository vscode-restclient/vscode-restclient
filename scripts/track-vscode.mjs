// What drags `vscode` in from a core file?
//
// Without this the terminal runner breaks at the first slip: `vscode` only
// exists inside the editor, and one import too many brings it down at start-up.
//
// It returns ALL the paths, not the first: memoising per file lost edges and
// gave a green light to a core that did drag the editor in.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] ?? 'src/cli/index.ts';

/** `import type` disappears on compile; `require('vscode')` only runs if called. */
const importsVscode = (source) => /^\s*import\s(?!type\s)[^;]*from\s+'vscode'/m.test(source);
const withoutTypes = (source) => source.replace(/^\s*import\s+type\s[^;]*;\s*$/gm, '');

const culprits = new Map();
const inProgress = new Set();

function search(file, trail) {
  const abs = path.resolve(file);
  if (inProgress.has(abs) || !fs.existsSync(abs)) return;
  inProgress.add(abs);

  const source = fs.readFileSync(abs, 'utf8');
  const rel = path.relative('.', abs).split(path.sep).join('/');
  const here = [...trail, rel];

  if (importsVscode(source)) {
    if (!culprits.has(rel)) culprits.set(rel, here);
  } else {
    for (const m of withoutTypes(source).matchAll(/from '(\.[^']+)'/g)) {
      const base = path.resolve(path.dirname(abs), m[1]);
      for (const candidate of [base + '.ts', path.join(base, 'index.ts')]) {
        search(candidate, here);
      }
    }
  }
  inProgress.delete(abs);
}

search(ROOT, []);

if (culprits.size === 0) {
  console.log(`${ROOT} does not drag vscode in`);
  process.exit(0);
}
console.log(`${ROOT} drags vscode in through ${culprits.size} path(s):\n`);
for (const [who, trail] of culprits) {
  console.log(`  ${who}`);
  console.log(`     ${trail.slice(0, -1).join(' -> ')}\n`);
}
process.exit(1);
