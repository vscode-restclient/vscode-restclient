import * as assert from 'assert';
import { faker } from '@faker-js/faker/locale/en';
import { substitute } from '../../cli/index';
import { fakerRegex, resolveFakerPath } from '../../utils/fakerShared';

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
