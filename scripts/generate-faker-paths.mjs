// Generates src/utils/static/fakerPaths.json: every `module.method` that
// `{{$faker module.method [params]}}` can call, with the documentation Faker
// ships in its type declarations. The completion list is built from it.
//
//   node scripts/generate-faker-paths.mjs          writes the file
//   node scripts/generate-faker-paths.mjs --check  fails if it is out of date
//
// Run by hand after bumping @faker-js/faker (npm run generate:faker), like
// generate-notices.mjs; the result is committed, so the type-check and the
// tests work on a fresh clone, and the audit runs --check to catch a bump that
// was not followed by a regeneration.
//
// Two sources, each for what it knows best:
// - the library at runtime says which methods exist (prototype chain of each
//   module, the same object `resolveFakerPath` walks);
// - its .d.ts says what they take and return, and carries the JSDoc.
//
// A .http file can only pass space-separated words and numbers, and the value
// is turned into text with String(). So a method is listed only when one of
// its signatures needs nothing but strings, numbers or booleans, and returns
// a primitive or a Date. That leaves out what would only ever produce
// "[object Object]" or an error: helpers.arrayElement (needs an array),
// science.chemicalElement (returns an object), date.between (needs { from, to }).
// Deprecated methods are left out too: a new .http file should not start
// depending on something the next Faker major removes.
// Faker's @example lines are kept as a sample value and, for calls with
// parameters, the arguments a .http line can express.

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'src/utils/static/fakerPaths.json');
const fakerDir = dirname(require.resolve('@faker-js/faker/package.json'));
const fakerVersion = JSON.parse(readFileSync(join(fakerDir, 'package.json'), 'utf8')).version;

// What exists: the same entry point the extension loads (fakerShared.ts).
const { faker } = await import('@faker-js/faker/locale/en');
const runtime = new Map();
for (const moduleName of Object.keys(faker)) {
    const mod = faker[moduleName];
    if (!mod || typeof mod !== 'object' || moduleName.startsWith('_') || moduleName === 'fakerCore') {
        continue;
    }
    const methods = new Set();
    for (let p = Object.getPrototypeOf(mod); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
        for (const name of Object.getOwnPropertyNames(p)) {
            if (name !== 'constructor' && !name.startsWith('_') && typeof mod[name] === 'function') {
                methods.add(name);
            }
        }
    }
    runtime.set(moduleName, methods);
}

// What they take, return and mean: the declarations of that same entry point.
const entry = require.resolve('@faker-js/faker/locale/en').replace(/\.js$/, '.d.ts');
const program = ts.createProgram([entry], { strict: true, skipLibCheck: true, noEmit: true });
const checker = program.getTypeChecker();
const source = program.getSourceFile(entry);
const fakerSymbol = checker.getExportsOfModule(checker.getSymbolAtLocation(source))
    .find(s => s.name === 'faker');
if (!fakerSymbol) {
    throw new Error(`no "faker" export in ${entry}`);
}
const fakerType = checker.getTypeOfSymbolAtLocation(fakerSymbol, source);

const PRIMITIVE = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike;

/**
 * A word or a number from the .http line can satisfy it. resolveFakerPath
 * passes a numeric word as a number and anything else as a string, so a
 * boolean (`false` arrives as the truthy text 'false') or a bigint cannot be
 * expressed.
 */
function acceptsPrimitive(type) {
    if (type.isUnion()) {
        return type.types.some(acceptsPrimitive);
    }
    return (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

/** String() of it reads as a value, not "[object Object]". */
function printable(type) {
    if (type.isUnion()) {
        return type.types.every(printable);
    }
    if (type.flags & (PRIMITIVE | ts.TypeFlags.Undefined | ts.TypeFlags.Null)) {
        return true;
    }
    return type.getSymbol()?.name === 'Date';
}

/** The required parameters a .http line has to provide, or undefined if it cannot. */
function requiredPrimitives(signature) {
    const required = [];
    for (const param of signature.getParameters()) {
        const decl = param.valueDeclaration;
        const optional = decl && ts.isParameter(decl) && (decl.questionToken || decl.initializer || decl.dotDotDotToken);
        if (optional) {
            continue;
        }
        if (!acceptsPrimitive(checker.getTypeOfSymbolAtLocation(param, source))) {
            return undefined;
        }
        required.push(param.name);
    }
    return required;
}

const clean = text => text.replace(/\r\n/g, '\n').trim();

/**
 * The first sentence only: the rest of Faker's prose is about calling it from
 * JavaScript, and the completion popup is not the place for it.
 */
function summary(text) {
    const paragraph = clean(text).split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, ' ');
    return (/^.+?\.(?=\s|$)/.exec(paragraph)?.[0] ?? paragraph).replace(/:$/, '.');
}

/** Long values (a JWT, a paragraph) only need to show their shape. */
const MAX_VALUE = 60;
function shortValue(comment) {
    const value = comment.replace(/^\/\/\s*/, '').trim().replace(/^'(.*)'$/, '$1');
    return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value;
}

/**
 * Typed to accept a word, but no word a .http line can carry makes sense:
 * helpers.fake needs a `{{module.method}}` pattern, and the first `}}` ends
 * the surrounding `{{$faker ...}}` variable.
 */
const UNUSABLE = new Set(['helpers.fake']);

const tagText = tag => clean(ts.displayPartsToString(tag.text ?? []));

/**
 * Faker's @example lines, reduced to what tells the user something:
 * - `faker.internet.email() // 'Kassandra4@hotmail.com'` -> sample `Kassandra4@hotmail.com`
 *   (the call itself is just the path; without a value it says nothing);
 * - `faker.string.alphanumeric(5) // '3e5V7'` -> example `["5", "3e5V7"]`.
 * Only calls a .http line can express are kept: numbers and single words.
 * The `{ length: 5 }` and `['a', 'b']` forms are dropped, and so are
 * booleans (`false` would arrive as the truthy text "false"), escapes
 * (`\n` arrives as backslash + n) and empty results.
 */
function fromExamples(examples, path) {
    const call = new RegExp(`^faker\\.${path.replace('.', '\\.')}\\((.*)\\)\\s*(//.*)?$`);
    const word = /^(-?\d+(\.\d+)?|'[^'\s{}\\]+'|"[^"\s{}\\]+")$/;
    let sample;
    const withArgs = new Map();
    for (const line of examples.flatMap(e => e.split('\n'))) {
        const m = call.exec(line.trim());
        if (!m) {
            continue;
        }
        const args = m[1].trim() ? m[1].split(',').map(a => a.trim()) : [];
        const value = m[2] ? shortValue(m[2]) : undefined;
        if (!args.every(a => word.test(a)) || value === '') {
            continue;
        }
        if (args.length === 0) {
            sample ??= value;
        } else {
            const words = args.map(a => a.replace(/^['"]|['"]$/g, '')).join(' ');
            if (!withArgs.has(words) || withArgs.get(words) === undefined) {
                withArgs.set(words, value);
            }
        }
    }
    const list = [...withArgs].map(([args, value]) => value === undefined ? [args] : [args, value]);
    return { sample, examples: list };
}

const entries = [];
const skipped = [];
for (const [moduleName, methods] of runtime) {
    const moduleProp = fakerType.getProperty(moduleName);
    const moduleType = moduleProp && checker.getTypeOfSymbolAtLocation(moduleProp, source);
    for (const method of [...methods].sort()) {
        const path = `${moduleName}.${method}`;
        const symbol = moduleType?.getProperty(method);
        if (!symbol) {
            skipped.push(`${path} (not declared)`);
            continue;
        }
        const signatures = checker.getTypeOfSymbolAtLocation(symbol, source).getCallSignatures();
        const usable = signatures
            .map(sig => ({ sig, required: requiredPrimitives(sig) }))
            .find(({ sig, required }) => required && printable(sig.getReturnType()));
        if (!usable || UNUSABLE.has(path)) {
            skipped.push(path);
            continue;
        }
        // The chosen overload's own JSDoc: the symbol's would join every overload's.
        const tags = usable.sig.getJsDocTags();
        if (tags.some(t => t.name === 'deprecated')) {
            skipped.push(`${path} (deprecated)`);
            continue;
        }
        const { sample, examples } = fromExamples(tags.filter(t => t.name === 'example').map(tagText), path);
        entries.push({
            path,
            description: summary(ts.displayPartsToString(usable.sig.getDocumentationComment(checker))),
            ...(usable.required.length ? { params: usable.required } : {}),
            ...(sample !== undefined ? { sample } : {}),
            ...(examples.length ? { examples } : {}),
        });
    }
}

// Code-unit order, not localeCompare: the result must not depend on the
// locale of the machine that runs --check.
entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
// One entry per line: compact, and a Faker bump still reads as a line diff.
const output = `{"fakerVersion":${JSON.stringify(fakerVersion)},"paths":[\n${entries.map(e => JSON.stringify(e)).join(',\n')}\n]}\n`;

if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(OUT, 'utf8'); } catch { /* missing counts as stale */ }
    if (current.replace(/\r\n/g, '\n') !== output) {
        console.error(`src/utils/static/fakerPaths.json is out of date for @faker-js/faker ${fakerVersion}: run node scripts/generate-faker-paths.mjs`);
        process.exit(1);
    }
    console.log(`fakerPaths.json up to date (${entries.length} paths, faker ${fakerVersion})`);
} else {
    writeFileSync(OUT, output);
    console.log(`fakerPaths.json: ${entries.length} paths, ${skipped.length} left out (faker ${fakerVersion})`);
    if (process.argv.includes('--verbose')) {
        console.log(`left out: ${skipped.join(', ')}`);
    }
}
