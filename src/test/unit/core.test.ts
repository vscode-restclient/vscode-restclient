import * as assert from 'assert';
import { splitBlocks, runSequence, Block, ExecutedStep } from '../../core/sequence';
import { readAssertions, checkAssertions, valueFor } from '../../core/assertions';

const BR = String.fromCharCode(10);
const j = (...l: string[]) => l.join(BR);

describe('trocear un fichero .http', () => {
    it('P-18 · separa por ### fuera del cuerpo', () => {
        const b = splitBlocks(j('GET http://a/1', '', '###', '', 'GET http://a/2'));
        assert.strictEqual(b.length, 2);
        assert.ok(b[0].text.includes('/1'));
        assert.ok(b[1].text.includes('/2'));
    });

    it('P-18 · un ### dentro del cuerpo TAMBIEN separa, como en REST Client', () => {
        // Limitacion heredada a proposito: el original parte aqui desde 2016 y
        // los ficheros de la gente cuentan con ello. Ser mas listo romperia la
        // compatibilidad, que es lo que hace este fork instalable sin trabajo.
        const b = splitBlocks(j('POST http://a', 'Content-Type: text/markdown', '', '### Un titulo de Markdown', 'texto'));
        assert.strictEqual(b.length, 2, 'se comporta igual que el original');
    });

    it('P-18 · un ### indentado NO separa: es la salida documentada', () => {
        const b = splitBlocks(j('POST http://a', 'Content-Type: text/markdown', '', '  ### Un titulo indentado', 'texto'));
        assert.strictEqual(b.length, 1);
    });

    it('recoge el nombre y la linea de cada bloque', () => {
        const b = splitBlocks(j('# @name login', 'POST http://a/auth', '', '###', '', 'GET http://a/x'));
        assert.strictEqual(b[0].name, 'login');
        assert.strictEqual(b[1].name, undefined);
        assert.strictEqual(b[1].line, 4);
    });

    it('ignora bloques vacios y separadores de mas', () => {
        assert.strictEqual(splitBlocks(j('###', '', '###', 'GET http://a', '###', '')).length, 1);
    });
});

describe('ejecutar en secuencia', () => {
    const response = (status: number) => ({ status, body: '{}', headers: {} });

    it('P-19 · ejecuta todos los bloques en orden', async () => {
        const vistos: string[] = [];
        const steps = await runSequence(splitBlocks(j('GET http://a/1', '###', 'GET http://a/2', '###', 'GET http://a/3')), {
            enviar: async (b: Block) => { vistos.push(b.text.trim()); return response(200); }
        });
        assert.deepStrictEqual(vistos.map(v => v.slice(-1)), ['1', '2', '3']);
        assert.strictEqual(steps.length, 3);
    });

    it('P-19 · cada bloque se resuelve cuando le toca, no antes', async () => {
        const hechos: ExecutedStep[] = [];
        const alResolver: number[] = [];
        await runSequence(splitBlocks(j('GET http://a/1', '###', 'GET http://a/2', '###', 'GET http://a/3')), {
            resolve: async (b) => { alResolver.push(hechos.length); return b; },
            enviar: async () => response(200),
            alTerminarPaso: (p) => { hechos.push(p); }
        });
        // Al resolver el bloque n ya han terminado los n anteriores: eso es lo
        // que permite encadenar {{login.response...}}.
        assert.deepStrictEqual(alResolver, [0, 1, 2]);
    });

    it('P-20 · un fallo detiene la secuencia', async () => {
        let sent = 0;
        const steps = await runSequence(splitBlocks(j('GET http://a/1', '###', 'GET http://a/2', '###', 'GET http://a/3')), {
            enviar: async () => { sent++; if (sent === 2) { throw new Error('sin conexion'); } return response(200); }
        });
        assert.strictEqual(steps.length, 2, 'no debe seguir tras el fallo');
        assert.strictEqual(steps[1].error, 'sin conexion');
        assert.strictEqual(sent, 2);
    });

    it('P-20 · con continuarTrasFallo llega hasta el final', async () => {
        let sent = 0;
        const steps = await runSequence(splitBlocks(j('GET http://a/1', '###', 'GET http://a/2', '###', 'GET http://a/3')), {
            continueOnFailure: true,
            enviar: async () => { sent++; if (sent === 2) { throw new Error('oops'); } return response(200); }
        });
        assert.strictEqual(steps.length, 3);
        assert.strictEqual(sent, 3);
    });
});

describe('aserciones', () => {
    const r = {
        status: 200,
        ms: 130,
        body: JSON.stringify({ token: 'abc123', total: 3, items: [{ id: 7 }], vacio: '' }),
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    };

    it('lee las aserciones de un bloque', () => {
        const a = readAssertions(j('GET http://a', '# @assert status == 200', '// @assert time < 500', 'no es una asercion'));
        assert.strictEqual(a.length, 2);
        assert.deepStrictEqual([a[0].subject, a[0].operator, a[0].expected], ['status', '==', '200']);
        assert.strictEqual(a[1].operator, '<');
    });

    it('resuelve los sujetos contra la respuesta', () => {
        assert.strictEqual(valueFor('status', r), '200');
        assert.strictEqual(valueFor('time', r), '130');
        assert.strictEqual(valueFor('body.$.token', r), 'abc123');
        assert.strictEqual(valueFor('body.$.items[0].id', r), '7');
        assert.strictEqual(valueFor('headers.content-type', r), 'application/json; charset=utf-8');
        assert.strictEqual(valueFor('headers.CONTENT-TYPE', r), 'application/json; charset=utf-8', 'las cabeceras no distinguen mayusculas');
        assert.strictEqual(valueFor('body.$.no-existe', r), '');
        assert.strictEqual(valueFor('header.content-type', r), 'application/json; charset=utf-8', 'header en singular tambien vale');
    });

    it('P-21 · los siete operadores, con su caso bueno y su caso malo', () => {
        const casos: [string, boolean][] = [
            ['status == 200', true], ['status == 404', false],
            ['status != 404', true], ['status != 200', false],
            ['time < 500', true], ['time < 10', false],
            ['time > 10', true], ['time > 500', false],
            ['headers.content-type contains json', true], ['headers.content-type contains xml', false],
            ['body.$.token matches ^abc[0-9]+$', true], ['body.$.token matches ^zzz', false],
            ['body.$.token exists', true], ['body.$.vacio exists', false]
        ];
        for (const [text, expected] of casos) {
            const [res] = checkAssertions(readAssertions('# @assert ' + text), r);
            assert.strictEqual(res.passed, expected, `"${text}" deberia ${expected ? 'pasar' : 'fallar'} y dio "${res.actual}"`);
        }
    });

    it('P-22 · una expresion regular monstruosa no cuelga la interfaz', () => {
        const pattern = '(a+)'.repeat(40) + '+$';
        const t0 = Date.now();
        const [res] = checkAssertions(readAssertions('# @assert body.$.token matches ' + pattern), r);
        assert.ok(Date.now() - t0 < 500, `tardo ${Date.now() - t0} ms`);
        assert.strictEqual(res.passed, false);
    });

    it('P-22 · un patron invalido falla la asercion, no lanza', () => {
        const [res] = checkAssertions(readAssertions('# @assert body.$.token matches ([sin-cerrar'), r);
        assert.strictEqual(res.passed, false);
    });

    it('una respuesta sin cuerpo no rompe nada', () => {
        const res = checkAssertions(readAssertions('# @assert body.$.a exists'), { ms: 5 });
        assert.strictEqual(res[0].passed, false);
    });

    it('P-31 · un sujeto que no existe se dice, no se calla', () => {
        const r = { status: 200, body: '{}', headers: { 'content-type': 'application/json' }, ms: 5 };
        const [mal] = checkAssertions(readAssertions('# @assert cabecera.content-type contains json'), r);
        assert.strictEqual(mal.passed, false);
        assert.ok(mal.actual.includes('cabecera.content-type'), 'el mensaje nombra el sujeto');

        // Lo peligroso era !=: contra '' pasaba, y el fichero parecia verde.
        const [negada] = checkAssertions(readAssertions('# @assert lo.que.sea != 200'), r);
        assert.strictEqual(negada.passed, false, 'un sujeto desconocido no puede dar por buena una asercion');

        const [bien] = checkAssertions(readAssertions('# @assert header.content-type contains json'), r);
        assert.strictEqual(bien.passed, true);
    });
});
