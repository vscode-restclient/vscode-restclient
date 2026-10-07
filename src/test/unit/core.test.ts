import * as assert from 'assert';
import { splitBlocks, runSequence, Block, ExecutedStep } from '../../core/sequence';
import { readAssertions, checkAssertions, valueFor } from '../../core/assertions';

const BR = String.fromCharCode(10);
const j = (...l: string[]) => l.join(BR);

describe('splitting a .http file', () => {
    it('P-18 · splits on ### outside the body', () => {
        const b = splitBlocks(j('GET http://a/1', '', '###', '', 'GET http://a/2'));
        assert.strictEqual(b.length, 2);
        assert.ok(b[0].text.includes('/1'));
        assert.ok(b[1].text.includes('/2'));
    });

    it('P-18 · a ### inside the body ALSO splits, as in REST Client', () => {
        // A limitation kept on purpose: the original has split here since 2016
        // and people's files count on it. Being smarter would break the
        // compatibility that makes this fork installable with no work.
        const b = splitBlocks(j('POST http://a', 'Content-Type: text/markdown', '', '### Un titulo de Markdown', 'texto'));
        assert.strictEqual(b.length, 2, 'behaves like the original');
    });

    it('P-18 · an indented ### does NOT split: that is the documented way out', () => {
        const b = splitBlocks(j('POST http://a', 'Content-Type: text/markdown', '', '  ### Un titulo indentado', 'texto'));
        assert.strictEqual(b.length, 1);
    });

    it('records the name and the line of each block', () => {
        const b = splitBlocks(j('# @name login', 'POST http://a/auth', '', '###', '', 'GET http://a/x'));
        assert.strictEqual(b[0].name, 'login');
        assert.strictEqual(b[1].name, undefined);
        assert.strictEqual(b[1].line, 4);
    });

    it('ignores empty blocks and extra separators', () => {
        assert.strictEqual(splitBlocks(j('###', '', '###', 'GET http://a', '###', '')).length, 1);
    });
});

describe('running in sequence', () => {
    const response = (status: number) => ({ status, body: '{}', headers: {} });

    it('P-19 · runs every block in order', async () => {
        const seen: string[] = [];
        const steps = await runSequence(splitBlocks(j('GET http://a/1', '###', 'GET http://a/2', '###', 'GET http://a/3')), {
            send: async (b: Block) => { seen.push(b.text.trim()); return response(200); }
        });
        assert.deepStrictEqual(seen.map(v => v.slice(-1)), ['1', '2', '3']);
        assert.strictEqual(steps.length, 3);
    });

    it('P-19 · each block is resolved when its turn comes, not before', async () => {
        const done: ExecutedStep[] = [];
        const alResolver: number[] = [];
        await runSequence(splitBlocks(j('GET http://a/1', '###', 'GET http://a/2', '###', 'GET http://a/3')), {
            resolve: async (b) => { alResolver.push(done.length); return b; },
            send: async () => response(200),
            onStepDone: (p) => { done.push(p); }
        });
        // By the time block n is resolved the n before it have finished: that
        // is what makes chaining {{login.response...}} possible.
        assert.deepStrictEqual(alResolver, [0, 1, 2]);
    });

    it('P-20 · an error stops the sequence', async () => {
        let sent = 0;
        const steps = await runSequence(splitBlocks(j('GET http://a/1', '###', 'GET http://a/2', '###', 'GET http://a/3')), {
            send: async () => { sent++; if (sent === 2) { throw new Error('sin conexion'); } return response(200); }
        });
        assert.strictEqual(steps.length, 2, 'must not go on after the error');
        assert.strictEqual(steps[1].error, 'sin conexion');
        assert.strictEqual(sent, 2);
    });

    it('P-20 · with continueOnFailure it goes all the way', async () => {
        let sent = 0;
        const steps = await runSequence(splitBlocks(j('GET http://a/1', '###', 'GET http://a/2', '###', 'GET http://a/3')), {
            continueOnFailure: true,
            send: async () => { sent++; if (sent === 2) { throw new Error('oops'); } return response(200); }
        });
        assert.strictEqual(steps.length, 3);
        assert.strictEqual(sent, 3);
    });
});

describe('assertions', () => {
    const r = {
        status: 200,
        ms: 130,
        body: JSON.stringify({ token: 'abc123', total: 3, items: [{ id: 7 }], vacio: '' }),
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
    };

    it('reads the assertions of a block', () => {
        const a = readAssertions(j('GET http://a', '# @assert status == 200', '// @assert time < 500', 'no es una asercion'));
        assert.strictEqual(a.length, 2);
        assert.deepStrictEqual([a[0].subject, a[0].operator, a[0].expected], ['status', '==', '200']);
        assert.strictEqual(a[1].operator, '<');
    });

    it('resolves the subjects against the response', () => {
        assert.strictEqual(valueFor('status', r), '200');
        assert.strictEqual(valueFor('time', r), '130');
        assert.strictEqual(valueFor('body.$.token', r), 'abc123');
        assert.strictEqual(valueFor('body.$.items[0].id', r), '7');
        assert.strictEqual(valueFor('headers.content-type', r), 'application/json; charset=utf-8');
        assert.strictEqual(valueFor('headers.CONTENT-TYPE', r), 'application/json; charset=utf-8', 'header names are case-insensitive');
        assert.strictEqual(valueFor('body.$.no-existe', r), '');
        assert.strictEqual(valueFor('header.content-type', r), 'application/json; charset=utf-8', 'header in the singular works too');
    });

    it('P-21 · the seven operators, each with a passing and a failing case', () => {
        const cases: [string, boolean][] = [
            ['status == 200', true], ['status == 404', false],
            ['status != 404', true], ['status != 200', false],
            ['time < 500', true], ['time < 10', false],
            ['time > 10', true], ['time > 500', false],
            ['headers.content-type contains json', true], ['headers.content-type contains xml', false],
            ['body.$.token matches ^abc[0-9]+$', true], ['body.$.token matches ^zzz', false],
            ['body.$.token exists', true], ['body.$.vacio exists', false]
        ];
        for (const [text, expected] of cases) {
            const [res] = checkAssertions(readAssertions('# @assert ' + text), r);
            assert.strictEqual(res.passed, expected, `"${text}" deberia ${expected ? 'pasar' : 'fallar'} y dio "${res.actual}"`);
        }
    });

    it('P-22 · a monstrous regular expression does not hang the UI', () => {
        const pattern = '(a+)'.repeat(40) + '+$';
        const t0 = Date.now();
        const [res] = checkAssertions(readAssertions('# @assert body.$.token matches ' + pattern), r);
        assert.ok(Date.now() - t0 < 500, `tardo ${Date.now() - t0} ms`);
        assert.strictEqual(res.passed, false);
    });

    it('P-22 · an invalid pattern fails the assertion, it does not throw', () => {
        const [res] = checkAssertions(readAssertions('# @assert body.$.token matches ([sin-cerrar'), r);
        assert.strictEqual(res.passed, false);
    });

    it('a response without a body breaks nothing', () => {
        const res = checkAssertions(readAssertions('# @assert body.$.a exists'), { ms: 5 });
        assert.strictEqual(res[0].passed, false);
    });

    it('P-31 · a subject that does not exist is reported, not swallowed', () => {
        const r = { status: 200, body: '{}', headers: { 'content-type': 'application/json' }, ms: 5 };
        const [bad] = checkAssertions(readAssertions('# @assert cabecera.content-type contains json'), r);
        assert.strictEqual(bad.passed, false);
        assert.ok(bad.actual.includes('cabecera.content-type'), 'the message names the subject');

        // The dangerous one was !=: against '' it passed, and the file looked green.
        const [negated] = checkAssertions(readAssertions('# @assert lo.que.sea != 200'), r);
        assert.strictEqual(negated.passed, false, 'an unknown subject cannot make an assertion pass');

        const [bien] = checkAssertions(readAssertions('# @assert header.content-type contains json'), r);
        assert.strictEqual(bien.passed, true);
    });
});
