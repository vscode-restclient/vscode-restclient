import * as assert from 'assert';
import got from 'got';
import { proxyAgents } from '../../utils/proxyAgents';
import { LocalProxy, LocalServer, startHttpServer, startHttpsServer, startProxy } from '../localServers';

// The module object itself, not the copy an `import * as` makes of it: the
// point of one of these tests is whether something replaced `https.request`
// behind our back.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const https: typeof import('https') = require('https');

const requestBefore = https.request;
const getBefore = https.get;

describe('proxy', () => {
    let proxy: LocalProxy;
    let plain: LocalServer;
    let secure: LocalServer;

    before(async () => {
        [proxy, plain, secure] = await Promise.all([startProxy(), startHttpServer(), startHttpsServer()]);
    });
    after(async () => {
        await Promise.all([proxy.close(), plain.close(), secure.close()]);
    });
    beforeEach(() => {
        proxy.seen.length = 0;
        proxy.credentials.length = 0;
    });

    /** The call httpClient.ts makes: got, the agents, and no certificate checks. */
    const through = async (url: string) => {
        const agent = await proxyAgents(`http://127.0.0.1:${proxy.port}`, false);
        assert.ok(agent, 'no agents for a valid proxy URL');
        return got(url, { agent, https: { rejectUnauthorized: false }, retry: 0 });
    };

    it('P-69 · proxy: an http request goes through it', async () => {
        const url = `http://127.0.0.1:${plain.port}/plain`;
        const r = await through(url);
        assert.strictEqual(r.headers.via, '1.1 test-proxy', 'the response did not come through the proxy');
        assert.deepStrictEqual(proxy.seen, [`GET ${url}`]);
        assert.strictEqual(JSON.parse(r.body).scheme, 'http');
    });

    it('P-70 · proxy: an https request opens a tunnel and arrives (#32)', async () => {
        const r = await through(`https://127.0.0.1:${secure.port}/secure`);
        assert.deepStrictEqual(proxy.seen, [`CONNECT 127.0.0.1:${secure.port}`]);
        assert.deepStrictEqual(JSON.parse(r.body), { scheme: 'https', path: '/secure', host: `127.0.0.1:${secure.port}` });
    });

    it('P-71 · proxy: a redirect from http to https stays behind the proxy', async () => {
        const destination = `https://127.0.0.1:${secure.port}/after-redirect`;
        const start = `http://127.0.0.1:${plain.port}/redirect?to=${encodeURIComponent(destination)}`;
        const r = await through(start);
        assert.deepStrictEqual(proxy.seen, [`GET ${start}`, `CONNECT 127.0.0.1:${secure.port}`]);
        assert.strictEqual(JSON.parse(r.body).path, '/after-redirect');
    });

    it('P-72 · proxy: loading the agents leaves https.request alone (#32)', async () => {
        await proxyAgents(`http://127.0.0.1:${proxy.port}`, false);
        assert.strictEqual(https.request, requestBefore, 'https.request was replaced');
        assert.strictEqual(https.get, getBefore, 'https.get was replaced');
        // The form got uses, and the one the old agents broke for everybody:
        // (url, options, callback).
        const status = await new Promise<number | undefined>((resolve, reject) => {
            https
                .request(new URL(`https://127.0.0.1:${secure.port}/direct`), { rejectUnauthorized: false }, (r) => {
                    r.resume();
                    resolve(r.statusCode);
                })
                .on('error', reject)
                .end();
        });
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(proxy.seen, [], 'a request without the agents must not touch the proxy');
    });

    it('P-78 · proxy: credentials in the proxy URL are sent to the proxy, for http and for https', async () => {
        const agent = await proxyAgents(`http://ana:s3cret@127.0.0.1:${proxy.port}`, false);
        assert.ok(agent);
        await got(`http://127.0.0.1:${plain.port}/a`, { agent, retry: 0 });
        await got(`https://127.0.0.1:${secure.port}/b`, { agent, https: { rejectUnauthorized: false }, retry: 0 });
        const basic = 'Basic ' + Buffer.from('ana:s3cret').toString('base64');
        assert.deepStrictEqual(proxy.credentials, [basic, basic]);
        assert.strictEqual(proxy.seen.length, 2);
    });

    it('P-79 · proxy: a Host header set by hand does not change where the request goes', async () => {
        // The way to reach one virtual host of a server addressed by IP.
        const url = `http://127.0.0.1:${plain.port}/vhost`;
        const agent = await proxyAgents(`http://127.0.0.1:${proxy.port}`, false);
        const r = await got(url, { agent, headers: { host: 'www.example.com' }, retry: 0 });
        assert.deepStrictEqual(proxy.seen, [`GET ${url}`], 'the proxy was asked for the host of the header, not of the URL');
        assert.strictEqual(JSON.parse(r.body).host, 'www.example.com', 'the header itself must still arrive');
    });

    it('P-80 · proxy: telling http from https does not depend on stack traces', async () => {
        // Stack traces are a process-wide setting. Left alone, the agents read
        // one to find out which protocol they serve.
        const limit = Error.stackTraceLimit;
        Error.stackTraceLimit = 0;
        try {
            const secured = await through(`https://127.0.0.1:${secure.port}/no-stack`);
            const unsecured = await through(`http://127.0.0.1:${plain.port}/no-stack`);
            assert.strictEqual(JSON.parse(secured.body).scheme, 'https');
            assert.strictEqual(JSON.parse(unsecured.body).scheme, 'http');
        } finally {
            Error.stackTraceLimit = limit;
        }
    });

    it('P-81 · proxy: an https:// proxy is reached over TLS, by name, and strictSSL decides whether its certificate is checked', async () => {
        const tlsProxy = await startProxy({ tls: true });
        try {
            const url = `https://localhost:${tlsProxy.port}`;
            const lenient = await proxyAgents(url, false);
            const overHttps = await got(`https://127.0.0.1:${secure.port}/tls-proxy`, { agent: lenient, https: { rejectUnauthorized: false }, retry: 0 });
            const overHttp = await got(`http://127.0.0.1:${plain.port}/tls-proxy`, { agent: lenient, retry: 0 });
            assert.strictEqual(JSON.parse(overHttps.body).scheme, 'https');
            assert.strictEqual(overHttp.headers.via, '1.1 test-proxy');
            assert.deepStrictEqual(tlsProxy.seen, [`CONNECT 127.0.0.1:${secure.port}`, `GET http://127.0.0.1:${plain.port}/tls-proxy`]);
            assert.deepStrictEqual(tlsProxy.serverNames, ['localhost', 'localhost'], 'the proxy must be asked for by name, for both schemes');

            // Its certificate is self-signed: with strictSSL nothing gets through,
            // and not because of the endpoint, whose certificate is not checked.
            tlsProxy.seen.length = 0;
            const strict = await proxyAgents(url, true);
            for (const target of [`https://127.0.0.1:${secure.port}/strict`, `http://127.0.0.1:${plain.port}/strict`]) {
                await assert.rejects(
                    got(target, { agent: strict, https: { rejectUnauthorized: false }, retry: 0 }),
                    (e: NodeJS.ErrnoException) => e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT',
                    target);
            }
            assert.deepStrictEqual(tlsProxy.seen, [], 'a proxy whose certificate was refused must not see the request');
        } finally {
            await tlsProxy.close();
        }
    });

    it('P-73 · proxy: a setting that is not an http(s) URL means no proxy', async () => {
        for (const value of ['', 'not a url', 'proxy.corp:8080', 'socks5://127.0.0.1:1080']) {
            assert.strictEqual(await proxyAgents(value, false), undefined, `"${value}"`);
        }
    });
});
