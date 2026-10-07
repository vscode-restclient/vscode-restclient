// End-to-end test of the terminal runner: starts a server, writes a .http with
// two chained requests and assertions, runs the runner and checks the output
// and the exit code.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUNNER = process.env.CLI_RUTA ?? 'dist-cli/cli/index.js';
if (!fs.existsSync(RUNNER)) {
  console.error(`the runner ${RUNNER} does not exist: build it first (npm run build:cli or npx webpack)`);
  process.exit(2);
}
console.log(`runner: ${RUNNER}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
const server = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'test-server.cjs');
const serverProcess = spawn(process.execPath, [server, '127.0.0.1'], { stdio: ['ignore', 'pipe', 'inherit'] });
const serverPort = await new Promise((res, rej) => {
  serverProcess.stdout.once('data', d => res(JSON.parse(d.toString()).port));
  setTimeout(() => rej(new Error('the server did not start')), 8000);
});

const BR = String.fromCharCode(10);
const write = (name, lines) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, lines.join(BR) + BR);
  return f;
};

const good = write('api.http', [
  `@host = http://127.0.0.1:${serverPort}`,
  '',
  '# @name login',
  'POST {{host}}/auth',
  'Content-Type: application/json',
  '',
  '{"user":"ana"}',
  '',
  '# @assert status == 200',
  '# @assert body.$.token exists',
  '',
  '###',
  '',
  '# @name facturas',
  'GET {{host}}/facturas',
  'Authorization: Bearer {{login.response.body.$.token}}',
  '',
  '# @assert status == 200',
  '# @assert body.$.total == 3',
  '# @assert header.content-type contains json',
  '# @assert headers.content-type contains application',
  '# @assert time < 10000',
]);

const bad = write('failing.http', [
  `GET http://127.0.0.1:${serverPort}/not-found`,
  '',
  '# @assert status == 200',
]);

const run = (args) => new Promise((res) => {
  const p = spawn(process.execPath, [RUNNER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  p.stdout.on('data', d => output += d);
  p.stderr.on('data', d => error += d);
  p.on('close', exitCode => res({ exitCode, output, error }));
});

let failures = 0;
const ok = (n, c, extra = '') => { console.log(`${c ? '  OK  ' : '  FAIL '} ${n}${extra ? ' · ' + extra : ''}`); if (!c) failures++; };

console.log('== P-23 · the whole file, with two chained requests');
const r1 = await run([good]);
console.log(r1.output.trim().split(BR).map(l => '     ' + l).join(BR));
ok('exits with code 0 when everything passes', r1.exitCode === 0, `code ${r1.exitCode}`);
ok('runs both requests', (r1.output.match(/ok /g) || []).length === 2);
ok('the token of the first reaches the second', r1.output.includes('facturas') && !/^(FAIL|ERROR)/m.test(r1.output));
ok('the summary counts the requests', r1.output.includes('2 requests, all green'), r1.output.trim().split(BR).pop());

console.log(BR + '== P-23 · a failing assertion');
const r2 = await run([bad]);
ok('exits with code 1', r2.exitCode === 1, `code ${r2.exitCode}`);
ok('says which assertion failed and with what value', r2.output.includes('status == 200') && r2.output.includes('404'));
ok('marks the failing request and counts it in the singular', /^FAIL /m.test(r2.output) && r2.output.includes('1 request, 1 failure') && !r2.output.includes('failures'), r2.output.trim().split(BR).pop());

console.log(BR + '== JSON output, for continuous integration');
const r3 = await run([good, '--json']);
let data = null;
try { data = JSON.parse(r3.output); } catch { /* reported below */ }
ok('the output is valid JSON', data !== null);
ok('one step per request, with its assertions', data?.steps?.length === 2 && data.steps[1].assertions.length === 5);
ok('the assertions on headers and time pass', data?.steps?.[1]?.assertions?.every(a => a.passed === true) === true,
  (data?.steps?.[1]?.assertions ?? []).filter(a => !a.passed).map(a => a.assertion?.raw ?? '?').join(' | '));
ok('each assertion says whether it passes', data?.steps?.[0]?.assertions?.every(a => a.passed === true) === true);

console.log(BR + '== variables from the command line');
const withVar = write('var.http', ['GET {{target}}/facturas', 'Authorization: Bearer tok-123', '', '# @assert status == 200']);
const r4 = await run([withVar, '--var', `target=http://127.0.0.1:${serverPort}`]);
ok('--var substitutes the variable', r4.exitCode === 0, r4.output.trim().split(BR)[0]);

console.log(BR + '== JetBrains format: environment files, import, run and secrets');
fs.writeFileSync(path.join(tmp, 'http-client.env.json'), JSON.stringify({ dev: { host: `http://127.0.0.1:${serverPort}`, path: '/echo/public' } }));
fs.writeFileSync(path.join(tmp, 'http-client.private.env.json'), JSON.stringify({ dev: { path: '/echo/private' } }));
fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
write(path.join('lib', 'auth.http'), ['# @name login', 'POST {{host}}/auth', 'Content-Type: application/json', '', '{"user":"ana"}']);
const jet = write('jet.http', [
  'import ./lib/auth.http',
  '',
  'run #login',
  '',
  '# @assert status == 200',
  '# @assert body.$.token exists',
  '',
  '###',
  '',
  'GET {{host}}{{path}}',
  'X-Test: {{$secret API_KEY}}-{{$random.integer(5,6)}}',
  '',
  '# @assert body.$.path == /echo/private',
  '# @assert body.$.header == clave-123-5',
  '',
  '###',
  '',
  'GET {{host}}/facturas',
  'Authorization: Bearer {{login.response.body.$.token}}',
  '',
  '# @assert status == 200',
]);
const r7 = await run([jet, '--env', 'dev', '--secret', 'API_KEY=clave-123', '--json']);
let d7 = null; try { d7 = JSON.parse(r7.output); } catch { /* below */ }
ok('--env reads the environment from http-client.env.json and the private one wins', r7.exitCode === 0 && d7?.steps?.[1]?.assertions?.every(a => a.passed), r7.output.slice(0, 300));
ok('run #login runs the imported request by its name', d7?.steps?.[0]?.name === 'login' && d7?.steps?.[0]?.status === 200);
ok('the response of the imported request chains in the importing file', d7?.steps?.[2]?.status === 200);
const r8 = await run([jet, '--env', 'dev']);
ok('without the secret, an error that says which one and how to pass it', r8.exitCode === 1 && r8.output.includes('missing secret "API_KEY"') && r8.output.includes('RESTCLIENT_SECRET_API_KEY'), r8.output.split(BR).find(l => l.includes('secret')) ?? '');
const r9 = await new Promise((res) => {
  const p2 = spawn(process.execPath, [RUNNER, jet, '--env', 'dev', '--continue'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RESTCLIENT_SECRET_API_KEY: 'clave-123' } });
  let output = ''; p2.stdout.on('data', d => output += d); p2.on('close', exitCode => res({ exitCode, output }));
});
ok('the secret also arrives through RESTCLIENT_SECRET*', r9.exitCode === 0, r9.output.split(BR)[1] ?? '');
const r10 = await run([jet, '--env', 'no-existe', '--secret', 'API_KEY=x', '--continue']);
ok('an environment that does not exist warns, lists the ones there are, and does not blow up', r10.exitCode !== 2 && r10.error.includes('--env no-existe: no such environment') && r10.error.includes('Available: dev'), r10.error.split(BR)[0]);

console.log(BR + '== streaming: SSE and WebSocket');
const sse = write('sse.http', [
  `GET http://127.0.0.1:${serverPort}/sse`,
  '',
  '# @assert status == 200',
  '# @assert header.content-type contains event-stream',
  '# @assert sse.count == 3',
  '# @assert sse.first == {"delta":"Hola"}',
  '# @assert sse.last == [DONE]',
]);
const r12 = await run([sse, '--timeout', '5000']);
ok('a text/event-stream is read whole and sse.* works', r12.exitCode === 0, r12.output.trim().split(BR).slice(0, 3).join(' | '));
const ws = write('socket.http', [
  '# @timeout 700',
  `WEBSOCKET ws://127.0.0.1:${serverPort}/socket`,
  'X-Test: ana',
  '',
  '{"a":1}',
  '===',
  'segundo',
  '',
  '# @assert status == 101',
  '# @assert ws.count == 3',
  '# @assert ws.first == hola ana',
  '# @assert ws.last == eco: segundo',
]);
const r13 = await run([ws, '--json']);
let d13 = null; try { d13 = JSON.parse(r13.output); } catch { /* below */ }
ok('WEBSOCKET: greeting, echo of two messages and close on @timeout', r13.exitCode === 0 && d13?.steps?.[0]?.status === 101, (d13?.steps?.[0]?.assertions ?? []).filter(a => !a.passed).map(a => a.assertion + ' -> ' + a.actual).join(' | ') || r13.error.slice(0, 200));

console.log(BR + '== multipart with a file, pasted cURL and --junit');
fs.writeFileSync(path.join(tmp, 'adjunto.txt'), 'attachment content {{host}}');
const multi = write('multi.http', [
  `POST http://127.0.0.1:${serverPort}/echo/subida`,
  'Content-Type: multipart/form-data; boundary=----limite',
  '',
  '------limite',
  'Content-Disposition: form-data; name="fichero"; filename="adjunto.txt"',
  'Content-Type: text/plain',
  '',
  '<@ ./adjunto.txt',
  '------limite--',
  '',
  '# @assert status == 200',
  '# @assert body.$.received contains attachment content http://127.0.0.1',
  '',
  '###',
  '',
  `curl -X POST http://127.0.0.1:${serverPort}/echo/curl \\`,
  "  -H 'X-Test: from-curl' \\",
  "  -d 'a=1'",
  '',
  '# @assert status == 200',
  '# @assert body.$.header == from-curl',
  '# @assert body.$.received == a=1',
]);
const junit = path.join(tmp, 'report.xml');
const r14 = await run([multi, '--var', `host=http://127.0.0.1:${serverPort}`, '--json', '--junit', junit]);
let d14 = null; try { d14 = JSON.parse(r14.output); } catch { /* below */ }
const multiBody = d14?.steps?.[0] ? '' : r14.output.slice(0, 200);
ok('a multipart with <@ file arrives with the content and the variables substituted', r14.exitCode === 0 && d14?.steps?.[0]?.assertions?.every(a => a.passed), (d14?.steps?.[0]?.assertions ?? []).filter(a => !a.passed).map(a => a.assertion + ' -> ' + a.actual).join(' | ') || multiBody);
ok('a pasted curl command is sent the way curl would', d14?.steps?.[1]?.assertions?.every(a => a.passed) === true, (d14?.steps?.[1]?.assertions ?? []).filter(a => !a.passed).map(a => a.assertion + ' -> ' + a.actual).join(' | '));
const xml = fs.existsSync(junit) ? fs.readFileSync(junit, 'utf8') : '';
ok('--junit writes a report with one case per request', xml.includes('tests="2" failures="0" errors="0"') && (xml.match(/<testcase /g) || []).length === 2, xml.slice(0, 120));
const r15 = await run([bad, '--junit', junit]);
const badXml = fs.readFileSync(junit, 'utf8');
ok('the report records the failed assertion', r15.exitCode === 1 && badXml.includes('failures="1"') && badXml.includes('<failure message="status == 200 -&gt; 404"/>'), badXml.split(BR).find(l => l.includes('failure')) ?? '');

console.log(BR + '== usage errors');
const r5 = await run([]);
ok('without a file it explains the usage', r5.exitCode === 2 && r5.error.includes('usage:'));
const r6 = await run([good, '--var', 'malescrita']);
ok('a malformed variable is rejected', r6.exitCode === 2 && r6.error.includes('malformed variable: "malescrita"'), r6.error.trim());
const r11 = await run([good, '--secret', 'sin-igual']);
ok('a malformed secret is rejected', r11.exitCode === 2 && r11.error.includes('malformed secret: "sin-igual"'), r11.error.trim());

// An option the runner does not know is an error, not a no-op: ignored, a
// stale `--continuar` in a CI would stop at the first request that cannot be
// sent, with nothing to say why. (What stops the sequence is a send error; a
// failing assertion does not stop it, with or without --continue.)
console.log(BR + '== unknown options and --continue');
const twoSteps = write('two.http', [
  `GET http://127.0.0.1:${serverPort}/echo/x`,
  'X-Test: {{$secret NO_ESTA}}',
  '',
  '###',
  '',
  `GET http://127.0.0.1:${serverPort}/facturas`,
  'Authorization: Bearer tok-123',
  '',
  '# @assert status == 200',
]);
const stepCount = (r) => { try { return JSON.parse(r.output).steps.length; } catch { return -1; } };
const r16 = await run([twoSteps, '--json']);
ok('without --continue it stops at the first request that errors', r16.exitCode === 1 && stepCount(r16) === 1, `${stepCount(r16)} steps`);
const r17 = await run([twoSteps, '--json', '--continue']);
ok('with --continue it goes to the end and still exits with 1', r17.exitCode === 1 && stepCount(r17) === 2, `${stepCount(r17)} steps`);
const r18 = await run([twoSteps, '--json', '--continuar']);
ok('the old name --continuar is rejected and the new one is named', r18.exitCode === 2 && r18.output === '' && r18.error.includes('unknown option --continuar') && r18.error.includes('--continue now'), r18.error.trim());
const r19 = await run([good, '--no-existe']);
ok('an unknown option is rejected without sending anything', r19.exitCode === 2 && r19.output === '' && r19.error.includes('unknown option --no-existe') && r19.error.includes('usage:'), r19.error.trim().split(BR)[0]);
// The MCP server: its root decides which files an agent may name, so an
// argument it does not understand stops it instead of leaving it in the current directory.
const r20 = await run(['mcp', '--raiz', tmp]);
ok('mcp --raiz (old name) does not start and names --root', r20.exitCode === 2 && r20.output === '' && r20.error.includes('--root now'), r20.error.trim());
const r21 = await run(['mcp', '--root']);
ok('mcp --root without a folder does not start', r21.exitCode === 2 && r21.error.includes('--root needs a folder'), r21.error.trim());
const r22 = await run(['mcp', tmp]);
ok('mcp with a stray argument does not start', r22.exitCode === 2 && r22.error.includes('unexpected argument'), r22.error.trim().split(BR)[0]);
const r26 = await run(['mcp', '--root', '']);
ok('mcp --root empty does not start (an undefined variable does not widen the root)', r26.exitCode === 2 && r26.output === '' && r26.error.includes('--root needs a folder'), r26.error.trim());
const r27 = await run(['mcp', '--root', tmp, '--root', tmp]);
ok('mcp with --root twice does not start', r27.exitCode === 2 && r27.output === '' && r27.error.includes('--root given twice'), r27.error.trim());
const twoFailures = write('two-failures.http', [
  `GET http://127.0.0.1:${serverPort}/not-found`,
  '',
  '# @assert status == 200',
  '',
  '###',
  '',
  `GET http://127.0.0.1:${serverPort}/not-found`,
  '',
  '# @assert status == 200',
]);
const r23 = await run([twoFailures]);
ok('a failing assertion does not stop the sequence, and the summary is plural', r23.exitCode === 1 && r23.output.includes('2 requests, 2 failures'), r23.output.trim().split(BR).pop());
const r24 = await run([bad, good]);
ok('two files are rejected instead of running only the last one', r24.exitCode === 2 && r24.output === '' && r24.error.includes('only one file per run, got 2'), r24.error.trim().slice(0, 40));
const r25 = await run([good, '--junit', '--json']);
ok('an option is not the value of another', r25.exitCode === 2 && r25.output === '' && r25.error.includes('--junit needs the path of the XML report, got "--json"'), r25.error.trim());
const r28 = await run(['--json', '--', good]);
ok('after -- what follows is the file', r28.exitCode === 0 && stepCount(r28) === 2, `${stepCount(r28)} steps`);

serverProcess.kill();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${BR}===== ${failures} failures`);
process.exit(failures ? 1 : 0);
