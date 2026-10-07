// Checks that both translations are complete and carry nothing extra.
//
// Two different mechanisms, and both have to be looked at:
//   - package.nls*.json  -> what shows in the listing, the commands and the settings
//   - l10n/bundle.*.json -> the strings the code passes through vscode.l10n.t()
// A missing key breaks nothing: it comes out in English and nobody notices
// until a user does. Hence a check here rather than an eyeball.
import fs from 'node:fs';
import path from 'node:path';

let failures = 0;
const ok = (n, c, extra = '') => {
    console.log(`  ${c ? 'OK   ' : 'FAIL '} ${n}${extra ? ' · ' + extra : ''}`);
    if (!c) failures++;
};
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// --- 1. The listing, the commands and the settings -------------------------
const base = readJson('package.nls.json');
const es = readJson('package.nls.es.json');
const baseKeys = Object.keys(base);
const missing = baseKeys.filter((k) => !(k in es));
const extraKeys = Object.keys(es).filter((k) => !(k in base));
const untranslated = baseKeys.filter((k) => k in es && es[k] === base[k]);

console.log('== package.nls (listing, commands and settings)');
ok('English has keys', baseKeys.length > 0, `${baseKeys.length} keys`);
ok('Spanish leaves none out', missing.length === 0, missing.join(', '));
ok('Spanish invents no keys', extraKeys.length === 0, extraKeys.join(', '));
ok('none was left copied from English', untranslated.length === 0, untranslated.join(', '));

// Every declared key has to be used in the manifest, and the other way round.
const manifest = fs.readFileSync('package.json', 'utf8');
const used = new Set([...manifest.matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]));
const declaredUnused = baseKeys.filter((k) => !used.has(k));
const usedUndeclared = [...used].filter((k) => !(k in base));
ok('no declared key is unused', declaredUnused.length === 0, declaredUnused.join(', '));
ok('the manifest asks for no key that does not exist', usedUndeclared.length === 0, usedUndeclared.join(', '));

// --- 2. The strings in the code --------------------------------------------
console.log('\n== l10n (strings in the code)');
const pkg = readJson('package.json');
ok('the manifest declares the l10n folder', pkg.l10n === './l10n', pkg.l10n ?? 'not declared');

const tsFiles = [];
const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name !== 'test') walk(p);
        } else if (e.name.endsWith('.ts')) {
            tsFiles.push(p);
        }
    }
};
walk('src');

// l10n.t('...') and l10n.t("...") with a literal; backtick templates cannot be
// translated and are caught separately.
const literals = new Map();
const withTemplate = [];
for (const f of tsFiles) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g)) {
        literals.set(m[1].replace(/\\'/g, "'").replace(/\\"/g, '"'), f);
    }
    for (const m of text.matchAll(/l10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g)) {
        literals.set(m[1].replace(/\\"/g, '"'), f);
    }
    if (/l10n\.t\(\s*`/.test(text)) withTemplate.push(f);
}

const bundleEs = readJson('l10n/bundle.l10n.es.json');
const notInBundle = [...literals.keys()].filter((k) => !(k in bundleEs));
const bundleExtra = Object.keys(bundleEs).filter((k) => !literals.has(k));

ok('the code passes strings through l10n.t', literals.size > 0, `${literals.size} strings`);
ok('all of them have Spanish', notInBundle.length === 0, notInBundle.slice(0, 5).join(' | '));
ok('Spanish translates no ghosts', bundleExtra.length === 0, bundleExtra.slice(0, 5).join(' | '));
ok('none was passed as a template (it would not be translated)', withTemplate.length === 0, withTemplate.join(', '));

// The placeholders {0}, {1}... have to be the same on both sides: if Spanish
// drops one, the user sees the text without the value.
const placeholders = (s) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');
const mismatch = [...literals.keys()].filter((k) => k in bundleEs && placeholders(k) !== placeholders(bundleEs[k]));
ok('the {0} placeholders match in both languages', mismatch.length === 0, mismatch.join(' | '));

console.log(`\n===== ${failures} failures`);
process.exit(failures ? 1 : 0);
