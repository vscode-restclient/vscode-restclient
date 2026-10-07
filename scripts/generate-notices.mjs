// Generates THIRD-PARTY-NOTICES.txt from the real production tree.
//
//   node scripts/generate-notices.mjs           rewrites the file
//   node scripts/generate-notices.mjs --check   exits 1 if the file is out of date
//
// Walks `npm ls --omit=dev --all --json` (what actually ships in the package)
// and, for every unique package, copies its license file from node_modules. If
// a package ships no such file, the SPDX identifier it declares is recorded: an
// honest notice beats an invented text. The audit checks separately that no
// production package is left without an entry.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const OUTPUT = path.join(ROOT, 'THIRD-PARTY-NOTICES.txt');
const SEP = '='.repeat(78);

// npm puts notices into the --json output (it took our CI down once): extract the object.
const json = (output) => {
  const i = output.indexOf('{');
  const f = output.lastIndexOf('}');
  if (i < 0 || f < i) {
    return {};
  }
  try {
    return JSON.parse(output.slice(i, f + 1));
  } catch {
    return {};
  }
};

let rawTree = '';
try {
  rawTree = execSync('npm ls --omit=dev --all --json', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  rawTree = e.stdout ?? '';
}
const tree = json(rawTree);

const packages = new Map(); // "name@version" -> name
const walk = (node) => {
  for (const [name, v] of Object.entries(node?.dependencies ?? {})) {
    if (!v.version) {
      continue; // optional dependency npm did not install: it does not ship, it does not count
    }
    packages.set(`${name}@${v.version}`, name);
    walk(v);
  }
};
walk(tree);

// npm nests packages when two versions coexist (e.g.
// string-width/node_modules/is-fullwidth-code-point): the real directory of
// each name@version is found by walking the tree on disk once.
const dirByKey = new Map();
const scan = (dirNM) => {
  let children = [];
  try {
    children = fs.readdirSync(dirNM);
  } catch {
    return;
  }
  for (const child of children) {
    if (child.startsWith('.')) {
      continue;
    }
    const candidates = child.startsWith('@')
      ? (() => { try { return fs.readdirSync(path.join(dirNM, child)).map((x) => `${child}/${x}`); } catch { return []; } })()
      : [child];
    for (const name of candidates) {
      const dir = path.join(dirNM, ...name.split('/'));
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (m.name && m.version && !dirByKey.has(`${m.name}@${m.version}`)) {
          dirByKey.set(`${m.name}@${m.version}`, dir);
        }
      } catch { /* folder without a manifest: carry on */ }
      scan(path.join(dir, 'node_modules'));
    }
  }
};
scan(path.join(ROOT, 'node_modules'));

const readLicense = (dir) => {
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const candidate = files
    .filter((f) => /^(licen[cs]e|copying)(\.|-|$)/i.test(f))
    .sort((a, b) => a.length - b.length)[0];
  return candidate ? fs.readFileSync(path.join(dir, candidate), 'utf8').replace(/\r\n/g, '\n').trim() : null;
};

const noticeEntries = [...packages.keys()].sort((a, b) => a.localeCompare(b, 'en')).map((key) => {
  const name = packages.get(key);
  const dir = dirByKey.get(key) ?? path.join(ROOT, 'node_modules', ...name.split('/'));
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch { /* no readable manifest: the minimal entry is emitted anyway */ }
  // Historical formats: string, {type}, an array of either, and the plural `licenses`.
  const normalise = (v) => Array.isArray(v)
    ? v.map((x) => (typeof x === 'object' ? x?.type : x)).filter(Boolean).join(' OR ')
    : (typeof v === 'object' ? v?.type : v);
  const licenseId = normalise(manifest.license) || normalise(manifest.licenses);
  const repo = typeof manifest.repository === 'string'
    ? manifest.repository
    : manifest.repository?.url ?? '';
  const cleanRepo = repo.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://');
  const authorName = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name ?? '';

  const lines = [key, `License: ${licenseId ?? 'unknown'}`];
  if (cleanRepo) {
    lines.push(`Repository: ${cleanRepo}`);
  }
  if (authorName) {
    lines.push(`Author: ${authorName}`);
  }
  const text = readLicense(dir);
  lines.push('', text ?? `(The package ships no license file; it declares "${licenseId ?? 'unknown'}" in its package.json.)`);
  return lines.join('\n');
});

const visibleName = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).displayName ?? 'REST Client';
const header = [
  `${visibleName} — third-party notices`,
  '',
  `${visibleName} continues REST Client, Copyright (c) 2016 - present Huachao Mao,`,
  'MIT License (see LICENSE). The packages below are bundled into the extension',
  'and the terminal runner. Each is reproduced with its own license text.',
  '',
  `Generated by scripts/generate-notices.mjs from the production dependency tree`,
  `(${noticeEntries.length} packages). Regenerate with: node scripts/generate-notices.mjs`,
].join('\n');

const content = header + '\n\n' + SEP + '\n\n' + noticeEntries.join('\n\n' + SEP + '\n\n') + '\n';

if (process.argv.includes('--check')) {
  const actual = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (actual === content) {
    console.log(`THIRD-PARTY-NOTICES.txt is up to date (${noticeEntries.length} packages).`);
    process.exit(0);
  }
  console.error('THIRD-PARTY-NOTICES.txt is out of date: run `node scripts/generate-notices.mjs` and commit the result.');
  process.exit(1);
}

fs.writeFileSync(OUTPUT, content);
console.log(`THIRD-PARTY-NOTICES.txt regenerated: ${noticeEntries.length} packages.`);
