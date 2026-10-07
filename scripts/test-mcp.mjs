// End-to-end test of the MCP server: starts `restclient mcp` with a root,
// talks to it over stdio the way an agent would and checks the answers.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUNNER = process.env.CLI_PATH ?? 'dist-cli/cli/index.js';
const SERVER = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'test-server.cjs');
const BR = String.fromCharCode(10);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
const serverProcess = spawn(process.execPath, [SERVER, '127.0.0.1'], { stdio: ['ignore', 'pipe', 'inherit'] });
const serverPort = await new Promise((res, rej) => {
  serverProcess.stdout.once('data', d => res(JSON.parse(d.toString()).port));
  setTimeout(() => rej(new Error('the server did not start')), 8000);
});

fs.writeFileSync(path.join(tmp, 'http-client.env.json'), JSON.stringify({ dev: { host: `http://127.0.0.1:${serverPort}` } }));
fs.writeFileSync(path.join(tmp, 'api.http'), [
  '# @name login', 'POST {{host}}/auth', 'Content-Type: application/json', '', '{"user":"ana"}', '', '# @assert status == 200', '',
  '###', '', '# @name facturas', 'GET {{host}}/facturas', 'Authorization: Bearer {{login.response.body.$.token}}', '', '# @assert body.$.total == 3', '',
  '###', '', 'GET {{host}}/echo/suelta', 'X-Test: {{$secret API_KEY}}', '',
].join(BR));
fs.writeFileSync(path.join(os.tmpdir(), 'fuera-de-raiz.http'), 'GET http://127.0.0.1/no');

const mcp = spawn(process.execPath, [RUNNER, 'mcp', '--root', tmp], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const pending = new Map();
mcp.stdout.on('data', d => {
  buffer += d;
  let cut;
  while ((cut = buffer.indexOf(BR)) >= 0) {
    const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});
let errors = '';
mcp.stderr.on('data', d => errors += d);
let nextId = 1;
const call = (method, params) => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, res);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + BR);
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`no answer to ${method}`)); } }, 15000);
});
const notify = (method) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + BR);
const tool = async (name, args) => {
  const r = await call('tools/call', { name, arguments: args });
  let data = null; try { data = JSON.parse(r.result?.content?.[0]?.text ?? ''); } catch { data = r.result?.content?.[0]?.text; }
  return { r, data };
};

let failures = 0;
const ok = (n, c, extra = '') => { console.log(`${c ? '  OK  ' : '  FAIL '} ${n}${extra ? ' · ' + extra : ''}`); if (!c) failures++; };

console.log('== protocol');
const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
ok('initialize returns the protocol version and the name', init.result?.protocolVersion === '2025-06-18' && init.result?.serverInfo?.name === 'restclient', JSON.stringify(init).slice(0, 120));
notify('notifications/initialized');
const ping = await call('ping', {});
ok('ping', ping.result !== undefined && !ping.error);
const list = await call('tools/list', {});
ok('tools/list announces the three tools', (list.result?.tools ?? []).map(t => t.name).sort().join(',') === 'list_requests,run_http_file,send_request');
const unknown = await call('no/existe', {});
ok('an unknown method gives -32601', unknown.error?.code === -32601);
mcp.stdin.write('this is not json' + BR);
const broken = await new Promise(res => { pending.set(null, res); setTimeout(() => res(null), 3000); });
ok('broken JSON gives -32700 with a null id', broken?.error?.code === -32700);

console.log(BR + '== tools');
const l = await tool('list_requests', { file: 'api.http' });
ok('list_requests lists name, method and URL without sending anything', l.data?.requests?.length === 3 && l.data.requests[0].name === 'login' && l.data.requests[0].method === 'POST' && l.data.requests[2].url === '{{host}}/echo/suelta', JSON.stringify(l.data).slice(0, 160));
const s = await tool('send_request', { file: 'api.http', name: 'login', env: 'dev' });
ok('send_request sends a request by its name', s.data?.ok === true && s.data?.steps?.[0]?.status === 200 && s.data.steps.length === 1, JSON.stringify(s.data).slice(0, 160));
const r = await tool('run_http_file', { file: 'api.http', env: 'dev', secrets: { API_KEY: 'k' } });
ok('run_http_file runs everything in order, with the assertions and the chain', r.data?.ok === true && r.data?.steps?.length === 3 && r.data.steps[1].assertions[0].passed === true, JSON.stringify(r.data?.steps?.map(p => [p.name, p.status])));
const withoutSecret = await tool('run_http_file', { file: 'api.http', env: 'dev' });
ok('without the secret, isError and a message that says which one', withoutSecret.r.result?.isError === true && JSON.stringify(withoutSecret.data).includes('API_KEY'), JSON.stringify(withoutSecret.data).slice(0, 120));
const outside = await tool('list_requests', { file: '../fuera-de-raiz.http' });
ok('a path outside the root is rejected', outside.r.result?.isError === true && String(outside.data).includes('outside the allowed root'));
const missing = await tool('list_requests', { file: 'nada.http' });
ok('a file that does not exist is reported', missing.r.result?.isError === true && String(missing.data).includes('does not exist'));
const badTool = await call('tools/call', { name: 'delete_everything', arguments: {} });
ok('an unknown tool gives -32602', badTool.error?.code === -32602);
ok('the server wrote nothing to stderr', errors.trim() === '', errors.slice(0, 120));
ok('the root is unchanged: the server does not write to disk', fs.readdirSync(tmp).sort().join(',') === 'api.http,http-client.env.json');

mcp.kill();
serverProcess.kill();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${BR}===== ${failures} failures`);
process.exit(failures ? 1 : 0);
