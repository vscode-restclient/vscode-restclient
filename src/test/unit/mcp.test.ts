import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { serveMcp } from '../../cli/mcp';
import { LocalServer, startHttpServer } from '../localServers';

/**
 * The MCP server, driven over its own stdio contract: one JSON-RPC line in,
 * one line out. The requests go to a local server that echoes the path.
 */
describe('mcp server', () => {
    let server: LocalServer;
    let root: string;

    before(async () => {
        server = await startHttpServer();
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-mcp-'));
        const lines = [
            `@host = http://127.0.0.1:${server.port}`,
            '',
            '# @name first',
            'GET {{host}}/one',
            '',
            '# @assert status == 200',
            '',
            '###',
            '',
            'GET {{host}}/two',
            '',
        ];
        fs.writeFileSync(path.join(root, 'api.http'), lines.join('\n'));
    });

    after(async () => {
        await server.close();
        fs.rmSync(root, { recursive: true, force: true });
    });

    function call(name: string, args: Record<string, unknown>): Promise<{ ok?: boolean; isError?: boolean; data: any }> {
        const input = new PassThrough();
        const output = new PassThrough();
        let text = '';
        return new Promise((resolve, reject) => {
            output.on('data', (chunk) => {
                text += String(chunk);
                const line = text.split('\n').find(l => l.trim());
                if (!line) {
                    return;
                }
                const reply = JSON.parse(line);
                if (reply.error) {
                    reject(new Error(reply.error.message));
                    return;
                }
                resolve({ isError: reply.result.isError, data: JSON.parse(reply.result.content[0].text) });
            });
            serveMcp(root, input, output);
            input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
        });
    }

    it('P-89 · list_requests numbers the lines from 1, as the editor and the Copilot tool do', async () => {
        const { data } = await call('list_requests', { file: 'api.http' });
        assert.strictEqual(data.file, 'api.http');
        assert.deepStrictEqual(data.requests.map((r: { name?: string; method: string; url: string; line: number }) => [r.name, r.method, r.url, r.line]), [
            // The first block starts at the top of the file; the second right after the `###`.
            ['first', 'GET', '{{host}}/one', 1],
            [undefined, 'GET', '{{host}}/two', 9],
        ]);
    });

    it('P-90 · send_request and run_http_file return the body along with status, time and assertions', async function () {
        this.timeout(10000);
        const one = await call('send_request', { file: 'api.http', name: 'first' });
        assert.strictEqual(one.isError, undefined, JSON.stringify(one.data).slice(0, 200));
        assert.strictEqual(one.data.ok, true);
        assert.strictEqual(one.data.steps.length, 1);
        assert.strictEqual(one.data.steps[0].status, 200);
        assert.ok(one.data.steps[0].body.includes('"path":"/one"'), 'the body came back: ' + one.data.steps[0].body);
        assert.deepStrictEqual(one.data.steps[0].assertions, [{ assertion: 'status == 200', passed: true, actual: '200' }]);

        const all = await call('run_http_file', { file: 'api.http' });
        assert.strictEqual(all.data.ok, true);
        assert.deepStrictEqual(all.data.steps.map((s: { name: string; status: number }) => [s.name, s.status]), [['first', 200], ['#2', 200]]);
        assert.ok(all.data.steps[1].body.includes('"path":"/two"'), all.data.steps[1].body);

        // A failed request keeps the shape and flags the error, with no body to show.
        fs.writeFileSync(path.join(root, 'down.http'), 'GET http://127.0.0.1:1/nobody\n');
        const down = await call('run_http_file', { file: 'down.http' });
        assert.strictEqual(down.isError, true);
        assert.strictEqual(down.data.ok, false);
        assert.strictEqual(down.data.steps[0].body, undefined);
        assert.ok(down.data.steps[0].error, JSON.stringify(down.data.steps[0]));
    });

    it('P-97 · without env, the environment selected in the editor in workspace mode', async function () {
        this.timeout(10000);
        const project = path.join(root, 'project');
        fs.mkdirSync(path.join(project, '.rest-client'), { recursive: true });
        fs.writeFileSync(path.join(project, 'http-client.env.json'), JSON.stringify({ picked: { p: '/picked' }, other: { p: '/other' } }));
        fs.writeFileSync(path.join(project, '.rest-client', 'environment.json'), JSON.stringify({ name: 'picked', label: 'picked', scope: 'workspace' }));
        fs.writeFileSync(path.join(project, 'sel.http'), ['# @name sel', `GET http://127.0.0.1:${server.port}{{p}}`, ''].join('\n'));
        const implicit = await call('send_request', { file: 'project/sel.http', name: 'sel' });
        assert.ok(implicit.data.steps[0].body.includes('"path":"/picked"'), JSON.stringify(implicit.data).slice(0, 300));
        const explicit = await call('send_request', { file: 'project/sel.http', name: 'sel', env: 'other' });
        assert.ok(explicit.data.steps[0].body.includes('"path":"/other"'), 'env still wins: ' + JSON.stringify(explicit.data).slice(0, 300));
    });

    it('P-98 · what a # @set takes in one call is there for the next calls of the same server, per environment, never in the reply', async function () {
        this.timeout(15000);
        const project = path.join(root, 'captures');
        fs.mkdirSync(project, { recursive: true });
        fs.writeFileSync(path.join(project, 'http-client.env.json'), JSON.stringify({ dev: { stage: 'dev' }, prod: { stage: 'prod' } }));
        fs.writeFileSync(path.join(project, 'auth.http'), [
            '# @name login',
            '# @set who = response.headers.x-answered-by',
            '# @set where = response.body.$.path',
            `GET http://127.0.0.1:${server.port}/login-{{stage}}`,
            '',
        ].join('\n'));
        fs.writeFileSync(path.join(project, 'use.http'), [
            '# @name use',
            `GET http://127.0.0.1:${server.port}/{{who}}{{where}}`,
            '',
        ].join('\n'));

        // One server for every call, as an agent's MCP client keeps it.
        const input = new PassThrough();
        const output = new PassThrough();
        const replies: any[] = [];
        let buffer = '';
        const waiting: ((r: any) => void)[] = [];
        output.on('data', chunk => {
            buffer += String(chunk);
            let at: number;
            while ((at = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, at);
                buffer = buffer.slice(at + 1);
                if (line.trim()) {
                    const reply = JSON.parse(line);
                    const parsed = { isError: reply.result?.isError, data: reply.result ? JSON.parse(reply.result.content[0].text) : reply.error };
                    const next = waiting.shift();
                    next ? next(parsed) : replies.push(parsed);
                }
            }
        });
        serveMcp(root, input, output);
        let id = 0;
        const send = (args: Record<string, unknown>) => new Promise<any>(resolve => {
            waiting.push(resolve);
            input.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'send_request', arguments: args } }) + '\n');
        });

        const before = await send({ file: 'captures/use.http', name: 'use', env: 'dev' });
        assert.strictEqual(before.isError, true, 'nothing taken yet: ' + JSON.stringify(before.data).slice(0, 300));
        assert.match(before.data.steps[0].error, /unresolved variables: who, where: .*a name a # @set takes/);

        const login = await send({ file: 'captures/auth.http', name: 'login', env: 'dev' });
        assert.strictEqual(login.isError, undefined, JSON.stringify(login.data).slice(0, 300));
        assert.deepStrictEqual(login.data.steps[0].captures, [
            { set: 'who = response.headers.x-answered-by', name: 'who', taken: true },
            { set: 'where = response.body.$.path', name: 'where', taken: true },
        ]);
        assert.ok(!JSON.stringify(login.data.steps[0].captures).includes('/login-dev'), 'the values are not in the reply');

        const after = await send({ file: 'captures/use.http', name: 'use', env: 'dev' });
        assert.strictEqual(after.isError, undefined, JSON.stringify(after.data).slice(0, 300));
        assert.ok(after.data.steps[0].body.includes('"path":"/http/login-dev"'), after.data.steps[0].body);

        // Another folder with an http-client.env.json of its own: its `dev` is another environment.
        fs.mkdirSync(path.join(project, 'other'), { recursive: true });
        fs.writeFileSync(path.join(project, 'other', 'http-client.env.json'), JSON.stringify({ dev: { stage: 'other-dev' } }));
        fs.copyFileSync(path.join(project, 'use.http'), path.join(project, 'other', 'use.http'));
        const otherFolder = await send({ file: 'captures/other/use.http', name: 'use', env: 'dev' });
        assert.strictEqual(otherFolder.isError, true, 'a dev of another env file does not see it: ' + JSON.stringify(otherFolder.data).slice(0, 300));

        const otherEnvironment = await send({ file: 'captures/use.http', name: 'use', env: 'prod' });
        assert.strictEqual(otherEnvironment.isError, true, 'a value taken against dev is not sent with prod');
        assert.match(otherEnvironment.data.steps[0].error, /unresolved variables: who, where/);
        input.end();
    });
});
