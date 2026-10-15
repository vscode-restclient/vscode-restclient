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
});
