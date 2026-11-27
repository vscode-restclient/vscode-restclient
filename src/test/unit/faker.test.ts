import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { faker } from '@faker-js/faker/locale/en';
import { substitute } from '../../cli/index';
import { fakerExampleLines, FakerPath, fakerPathBeingTyped, fakerRegex, resolveFakerPath } from '../../utils/fakerShared';

describe('faker: {{$faker module.property [params]}} (ported from rest-client-next)', () => {
    it('P-57 · resolveFakerPath walks the path and calls the method', () => {
        const email = resolveFakerPath(faker, 'internet.email');
        assert.ok('value' in email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value), `no parece un email: ${JSON.stringify(email)}`);
    });

    it('P-58 · numeric parameters arrive as numbers', () => {
        const r = resolveFakerPath(faker, 'string.alphanumeric', '8');
        assert.ok('value' in r && r.value.length === 8, `expected 8 characters: ${JSON.stringify(r)}`);
    });

    it('P-59 · a path that does not exist warns instead of blowing up', () => {
        const r = resolveFakerPath(faker, 'no.existe');
        assert.ok('error' in r && r.error.includes('no.existe'));
    });

    it('P-60 · a property that is not a function returns its value', () => {
        // faker.definitions exists and is not a function: any leaf of data will do.
        const r = resolveFakerPath(faker, 'science.chemicalElement');
        assert.ok('value' in r, JSON.stringify(r));
    });

    it('P-61 · the regex accepts a bare path and a path with parameters', () => {
        assert.deepStrictEqual(fakerRegex.exec('$faker internet.email')?.slice(1, 3), ['internet.email', undefined]);
        assert.deepStrictEqual(fakerRegex.exec('$faker string.alphanumeric 8')?.slice(1, 3), ['string.alphanumeric', '8']);
    });

    it('P-62 · the runner replaces {{$faker ...}} just like the editor', () => {
        const output = substitute('GET https://x/?u={{$faker internet.username}}', {});
        assert.ok(!output.includes('{{'), `left unreplaced: ${output}`);
    });

    it('P-63 · in the runner, a path that does not exist leaves the variable as it was', () => {
        const output = substitute('{{$faker no.existe}}', {});
        assert.strictEqual(output, '{{$faker no.existe}}');
    });
});

describe('faker: the completion list generated at build time (scripts/generate-faker-paths.mjs)', () => {
    // Read from the source tree: out-test/test/unit -> src/utils/static.
    const list: { fakerVersion: string; paths: FakerPath[] } = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, '../../../src/utils/static/fakerPaths.json'), 'utf8'));

    it('P-101 · the list covers every Faker module, and was generated from the installed version', () => {
        const installed = JSON.parse(fs.readFileSync(require.resolve('@faker-js/faker/package.json'), 'utf8')).version;
        assert.strictEqual(list.fakerVersion, installed, 'run node scripts/generate-faker-paths.mjs');
        const listed = new Set(list.paths.map(p => p.path.split('.')[0]));
        // A module must be there as soon as one of its methods gives text with
        // no arguments (science, for one, only returns objects).
        const usable = (mod: any) => {
            for (let p = Object.getPrototypeOf(mod); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
                for (const name of Object.getOwnPropertyNames(p)) {
                    try {
                        if (name !== 'constructor' && !name.startsWith('_') && !String(mod[name]()).includes('[object Object]')) {
                            return true;
                        }
                    } catch { /* needs arguments */ }
                }
            }
            return false;
        };
        const modules = Object.keys(faker).filter(k => k !== 'fakerCore' && !k.startsWith('_') && typeof (faker as any)[k] === 'object');
        assert.deepStrictEqual(modules.filter(m => !listed.has(m) && usable((faker as any)[m])), [], 'modules with nothing in the list');
        assert.ok(list.paths.length >= 200, `only ${list.paths.length} paths`);
    });

    it('P-101 · every listed path resolves to a printable value, with its first example\'s parameters', () => {
        for (const entry of list.paths) {
            // Methods with required parameters are called the way their first example does.
            const params = entry.params ? entry.examples![0][0] : undefined;
            const r = resolveFakerPath(faker, entry.path, params);
            assert.ok('value' in r, `${entry.path}: ${JSON.stringify(r)}`);
            assert.ok(!r.value.includes('[object Object]'), `${entry.path} gives ${r.value}`);
        }
    });

    it('P-101 · the examples are .http lines the runner resolves', () => {
        const examples = list.paths.flatMap(fakerExampleLines);
        assert.ok(examples.length > list.paths.length, `only ${examples.length} examples`);
        assert.deepStrictEqual(fakerExampleLines({ path: 'string.alphanumeric', description: '', sample: '2', examples: [['5', '3e5V7'], ['8']] }),
            ['{{$faker string.alphanumeric}} // 2', '{{$faker string.alphanumeric 5}} // 3e5V7', '{{$faker string.alphanumeric 8}}']);
        for (const example of examples) {
            const line = example.replace(/ \/\/.*$/, '');
            const output = substitute(line, {});
            assert.ok(!output.includes('{{'), `left unreplaced: ${line}`);
        }
    });

    it('P-101 · what a .http line cannot call is left out', () => {
        const paths = new Set(list.paths.map(p => p.path));
        // An array, an object, a function or a nested {{ }} would be needed.
        for (const p of ['helpers.arrayElement', 'helpers.multiple', 'date.between', 'science.chemicalElement', 'helpers.fake']) {
            assert.ok(!paths.has(p), `${p} should not be offered`);
        }
        // Deprecated: the next Faker major removes it.
        assert.ok(!paths.has('image.urlLoremFlickr'), 'deprecated methods should not be offered');
    });

    it('P-100 · the path is completed right after {{$faker and while it is typed, not in the parameters', () => {
        assert.strictEqual(fakerPathBeingTyped('GET /x?e={{$faker '), '');
        assert.strictEqual(fakerPathBeingTyped('GET /x?e={{$faker inter'), 'inter');
        assert.strictEqual(fakerPathBeingTyped('{{ $faker   internet.em'), 'internet.em');
        assert.strictEqual(fakerPathBeingTyped('{{$faker string.alphanumeric '), undefined);
        assert.strictEqual(fakerPathBeingTyped('{{$faker internet.email}} '), undefined);
        assert.strictEqual(fakerPathBeingTyped('{{$fakerx '), undefined);
        assert.strictEqual(fakerPathBeingTyped('$faker '), undefined);
    });
});
