import * as assert from 'assert';
import { faker } from '@faker-js/faker/locale/en';
import { sustituir } from '../../cli/index';
import { fakerRegex, resolveFakerPath } from '../../utils/fakerShared';

describe('faker: {{$faker module.property [params]}} (ported from rest-client-next)', () => {
    it('P-57 · resolveFakerPath navega la ruta y llama al método', () => {
        const email = resolveFakerPath(faker, 'internet.email');
        assert.ok('value' in email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value), `no parece un email: ${JSON.stringify(email)}`);
    });

    it('P-58 · los parámetros numéricos llegan como números', () => {
        const r = resolveFakerPath(faker, 'string.alphanumeric', '8');
        assert.ok('value' in r && r.value.length === 8, `esperaba 8 caracteres: ${JSON.stringify(r)}`);
    });

    it('P-59 · una ruta inexistente avisa en vez de explotar', () => {
        const r = resolveFakerPath(faker, 'no.existe');
        assert.ok('error' in r && r.error.includes('no.existe'));
    });

    it('P-60 · una propiedad que no es función devuelve su valor', () => {
        // faker.definitions existe y no es función: cualquier hoja de datos vale.
        const r = resolveFakerPath(faker, 'science.chemicalElement');
        assert.ok('value' in r, JSON.stringify(r));
    });

    it('P-61 · el regex admite ruta sola y ruta con parámetros', () => {
        assert.deepStrictEqual(fakerRegex.exec('$faker internet.email')?.slice(1, 3), ['internet.email', undefined]);
        assert.deepStrictEqual(fakerRegex.exec('$faker string.alphanumeric 8')?.slice(1, 3), ['string.alphanumeric', '8']);
    });

    it('P-62 · el runner sustituye {{$faker ...}} igual que el editor', () => {
        const salida = sustituir('GET https://x/?u={{$faker internet.username}}', {});
        assert.ok(!salida.includes('{{'), `quedó sin sustituir: ${salida}`);
    });

    it('P-63 · en el runner, una ruta inexistente deja la variable como estaba', () => {
        const salida = sustituir('{{$faker no.existe}}', {});
        assert.strictEqual(salida, '{{$faker no.existe}}');
    });
});
