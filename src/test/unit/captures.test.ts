import * as assert from 'assert';
import { applyCaptures, captureFailures, capturesOf, captureTargets, CaptureStore, parseCapture, readCaptures } from '../../core/captures';
import { unresolvedVariables } from '../../core/variables';

const BR = String.fromCharCode(10);
const j = (...l: string[]) => l.join(BR);

const response = {
    status: 200,
    body: JSON.stringify({ token: 'tok-123', user: { id: 7, roles: ['a', 'b'] }, empty: '' }),
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'r-1' },
    ms: 12,
};

// P-98: `# @set name = response.body.$.path` keeps a value of the response
// for the requests that follow, with the syntax of rest-client-next and the
// path language of `# @assert`.
describe('# @set', () => {
    it('P-98 · reads the syntax of rest-client-next, and the same without the "response." prefix', () => {
        assert.deepStrictEqual(parseCapture('token = response.body.$.token'), { raw: 'token = response.body.$.token', name: 'token', subject: 'body.$.token' });
        assert.deepStrictEqual(parseCapture('rid=response.headers.X-Request-Id'), { raw: 'rid=response.headers.X-Request-Id', name: 'rid', subject: 'headers.X-Request-Id' });
        assert.strictEqual(parseCapture('token = body.$.token').subject, 'body.$.token');
        assert.strictEqual(parseCapture('code = status').subject, 'status');
        assert.strictEqual(parseCapture('raw = response.body.*').subject, 'body.*');
    });

    it('P-98 · only the first = separates: a path may hold more', () => {
        const c = parseCapture("id = response.body.$.items[?(@.name=='x')].id");
        assert.strictEqual(c.name, 'id');
        assert.strictEqual(c.subject, "body.$.items[?(@.name=='x')].id");
        assert.strictEqual(c.problem, undefined);
    });

    it('P-98 · a line it cannot apply says why, instead of being skipped in silence', () => {
        assert.match(parseCapture('').problem ?? '', /expected "# @set name = /);
        assert.match(parseCapture('token response.body.$.token').problem ?? '', /expected/);
        assert.match(parseCapture('= response.body.$.token').problem ?? '', /expected/);
        assert.match(parseCapture('1token = response.body.$.token').problem ?? '', /not a variable name/);
        assert.match(parseCapture('a.b = response.body.$.token').problem ?? '', /not a variable name/);
        assert.match(parseCapture('t = request.headers.Authorization').problem ?? '', /only the response/);
        assert.match(parseCapture('t = response.cookies.sid').problem ?? '', /unknown source "response.cookies.sid"/);
        assert.match(parseCapture('t = response.headers.').problem ?? '', /unknown source/);
    });

    it('P-98 · finds the lines with # and //, anywhere in the block, in order; @settings is not one', () => {
        const block = j(
            '# @name login',
            '# @set token = response.body.$.token',
            'POST http://h/auth',
            '',
            '{"user": "ana"}',
            '',
            '//   @set   rid = response.headers.X-Request-Id  ',
            '# @settings are not a capture',
            '# @set',
        );
        const captures = readCaptures(block);
        assert.deepStrictEqual(captures.map(c => [c.name, c.subject, c.problem === undefined]), [
            ['token', 'body.$.token', true],
            ['rid', 'headers.X-Request-Id', true],
            ['', '', false],
        ]);
    });

    it('P-98 · a run #name block takes the captures of the request it runs, then its own', () => {
        const login = j('# @name login', '# @set token = response.body.$.token', 'POST http://h/auth');
        const run = j('# @set token = response.headers.X-Token', '# @set id = response.body.$.user.id', 'run #login');
        assert.deepStrictEqual(capturesOf(run, login).map(c => `${c.name}=${c.subject}`), [
            'token=body.$.token',
            'token=headers.X-Token',
            'id=body.$.user.id',
        ]);
        assert.deepStrictEqual(capturesOf(login, login).map(c => c.name), ['token'], 'a plain block is read once');
        assert.deepStrictEqual(capturesOf(login).map(c => c.name), ['token']);
    });

    it('P-98 · takes the values, a header whatever its case, a non-string as JSON', () => {
        const into = new Map<string, string>();
        const results = applyCaptures(readCaptures(j(
            '# @set token = response.body.$.token',
            '# @set rid = response.headers.x-request-id',
            '# @set user = response.body.$.user',
            '# @set role = response.body.$.user.roles[1]',
            '# @set code = status',
        )), response, into);
        assert.deepStrictEqual(results.map(r => r.error), [undefined, undefined, undefined, undefined, undefined]);
        assert.deepStrictEqual(Object.fromEntries(into), {
            token: 'tok-123',
            rid: 'r-1',
            user: '{"id":7,"roles":["a","b"]}',
            role: 'b',
            code: '200',
        });
    });

    it('P-98 · a source that finds nothing takes nothing: the variable keeps its value, and the result says why', () => {
        const into = new Map([['token', 'old'], ['rid', 'old-rid']]);
        const results = applyCaptures(readCaptures(j(
            '# @set token = response.body.$.missing',
            '# @set rid = response.headers.X-Absent',
            '# @set e = response.body.$.empty',
            '# @set bad = request.body',
        )), response, into);
        assert.deepStrictEqual(Object.fromEntries(into), { token: 'old', rid: 'old-rid' });
        assert.deepStrictEqual(results.map(r => r.value), [undefined, undefined, undefined, undefined]);
        assert.deepStrictEqual(captureFailures(results), [
            '@set token = response.body.$.missing   ->  nothing found at body.$.missing',
            '@set rid = response.headers.X-Absent   ->  nothing found at headers.X-Absent',
            '@set e = response.body.$.empty   ->  nothing found at body.$.empty',
            '@set bad = request.body   ->  only the response can be captured: the request is what you wrote',
        ]);
    });

    it('P-98 · a body that is not JSON takes nothing from a JSON path, and everything from body', () => {
        const html = { status: 200, body: '<p>hi</p>', headers: {}, ms: 1 };
        const into = new Map<string, string>();
        const results = applyCaptures(readCaptures(j('# @set a = response.body.$.x', '# @set b = response.body')), html, into);
        assert.deepStrictEqual(results.map(r => r.error === undefined), [false, true]);
        assert.deepStrictEqual(Object.fromEntries(into), { b: '<p>hi</p>' });
    });

    it('P-98 · the store keeps one set of values per scope, and the same Map each time', () => {
        const store = new CaptureStore();
        store.scope('dev').set('token', 'dev-token');
        assert.strictEqual(store.scope('dev').get('token'), 'dev-token');
        assert.strictEqual(store.scope('prod').has('token'), false, 'a value taken against dev is never seen in prod');
        assert.strictEqual(store.scope('dev'), store.scope('dev'));
        store.clear();
        assert.strictEqual(store.scope('dev').size, 0);
    });

    it('P-98 · the names a text sets, once each and without the lines that cannot apply', () => {
        assert.deepStrictEqual(captureTargets(j('# @set token = response.body.$.a', '# @set token = response.body.$.b', '# @set 9 = status', '// @set id = status')), ['token', 'id']);
    });

    it('P-98 · a {{…}} on a # @set line is not counted as unresolved: the line is not sent', () => {
        assert.deepStrictEqual(unresolvedVariables(j('# @set token = response.body.$.{{x}}', 'GET http://h/a', '', '{}', '# @set id = {{y}}')), []);
    });
});
