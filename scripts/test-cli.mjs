// Prueba del runner de terminal de punta a punta: levanta un servidor, escribe
// un .http con dos peticiones encadenadas y aserciones, ejecuta `dist/cli.js`
// y comprueba la salida y el código de retorno.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUNNER = process.env.CLI_RUTA ?? 'dist-cli/cli/index.js';
if (!fs.existsSync(RUNNER)) {
  console.error(`no existe el runner ${RUNNER}: compilalo antes (npm run build:cli o npx webpack)`);
  process.exit(2);
}
console.log(`runner: ${RUNNER}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-prueba-'));
const server = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'test-server.cjs');
const hijo = spawn(process.execPath, [server, '127.0.0.1'], { stdio: ['ignore', 'pipe', 'inherit'] });
const puerto = await new Promise((res, rej) => {
  hijo.stdout.once('data', d => res(JSON.parse(d.toString()).port));
  setTimeout(() => rej(new Error('el servidor no arrancó')), 8000);
});

const BR = String.fromCharCode(10);
const escribir = (name, lines) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, lines.join(BR) + BR);
  return f;
};

const bueno = escribir('api.http', [
  `@host = http://127.0.0.1:${puerto}`,
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

const malo = escribir('falla.http', [
  `GET http://127.0.0.1:${puerto}/not-found`,
  '',
  '# @assert status == 200',
]);

const correr = (args) => new Promise((res) => {
  const p = spawn(process.execPath, [RUNNER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  p.stdout.on('data', d => output += d);
  p.stderr.on('data', d => error += d);
  p.on('close', exitCode => res({ exitCode, output, error }));
});

let failures = 0;
const ok = (n, c, extra = '') => { console.log(`${c ? '  OK  ' : '  FALLA'} ${n}${extra ? ' · ' + extra : ''}`); if (!c) failures++; };

console.log('== P-23 · el fichero completo, con dos peticiones encadenadas');
const r1 = await correr([bueno]);
console.log(r1.output.trim().split(BR).map(l => '     ' + l).join(BR));
ok('sale con código 0 cuando todo pasa', r1.exitCode === 0, `código ${r1.exitCode}`);
ok('ejecuta las dos peticiones', (r1.output.match(/ok /g) || []).length === 2);
ok('el token de la primera llega a la segunda', r1.output.includes('facturas') && !/^(FAIL|ERROR)/m.test(r1.output));
ok('el resumen cuenta las peticiones', r1.output.includes('2 requests, all green'), r1.output.trim().split(BR).pop());

console.log(BR + '== P-23 · una aserción que falla');
const r2 = await correr([malo]);
ok('sale con código 1', r2.exitCode === 1, `código ${r2.exitCode}`);
ok('dice qué aserción falló y con qué valor', r2.output.includes('status == 200') && r2.output.includes('404'));
ok('marca la petición que falla y la cuenta en singular', /^FAIL /m.test(r2.output) && r2.output.includes('1 request, 1 failure') && !r2.output.includes('failures'), r2.output.trim().split(BR).pop());

console.log(BR + '== salida en JSON, para integración continua');
const r3 = await correr([bueno, '--json']);
let data = null;
try { data = JSON.parse(r3.output); } catch { /* se reporta abajo */ }
ok('la salida es JSON válido', data !== null);
ok('trae un paso por petición con sus aserciones', data?.steps?.length === 2 && data.steps[1].assertions.length === 5);
ok('las aserciones sobre cabeceras y tiempo pasan', data?.steps?.[1]?.assertions?.every(a => a.passed === true) === true,
  (data?.steps?.[1]?.assertions ?? []).filter(a => !a.passed).map(a => a.assertion?.raw ?? '?').join(' | '));
ok('cada aserción dice si pasa', data?.steps?.[0]?.assertions?.every(a => a.passed === true) === true);

console.log(BR + '== variables desde la línea de órdenes');
const conVar = escribir('var.http', ['GET {{destino}}/facturas', 'Authorization: Bearer tok-123', '', '# @assert status == 200']);
const r4 = await correr([conVar, '--var', `destino=http://127.0.0.1:${puerto}`]);
ok('--var sustituye la variable', r4.exitCode === 0, r4.output.trim().split(BR)[0]);

console.log(BR + '== formato JetBrains: entornos de fichero, import, run y secretos');
fs.writeFileSync(path.join(tmp, 'http-client.env.json'), JSON.stringify({ dev: { host: `http://127.0.0.1:${puerto}`, path: '/echo/public' } }));
fs.writeFileSync(path.join(tmp, 'http-client.private.env.json'), JSON.stringify({ dev: { path: '/echo/private' } }));
fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true });
escribir(path.join('lib', 'auth.http'), ['# @name login', 'POST {{host}}/auth', 'Content-Type: application/json', '', '{"user":"ana"}']);
const jet = escribir('jet.http', [
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
const r7 = await correr([jet, '--env', 'dev', '--secret', 'API_KEY=clave-123', '--json']);
let d7 = null; try { d7 = JSON.parse(r7.output); } catch { /* abajo */ }
ok('--env lee el entorno de http-client.env.json y el privado manda', r7.exitCode === 0 && d7?.steps?.[1]?.assertions?.every(a => a.passed), r7.output.slice(0, 300));
ok('run #login ejecuta la petición importada con su nombre', d7?.steps?.[0]?.name === 'login' && d7?.steps?.[0]?.status === 200);
ok('la respuesta del importado encadena en el fichero que importa', d7?.steps?.[2]?.status === 200);
const r8 = await correr([jet, '--env', 'dev']);
ok('sin el secreto, error que dice cuál y cómo pasarlo', r8.exitCode === 1 && r8.output.includes('missing secret "API_KEY"') && r8.output.includes('RESTCLIENT_SECRET_API_KEY'), r8.output.split(BR).find(l => l.includes('secret')) ?? '');
const r9 = await new Promise((res) => {
  const p2 = spawn(process.execPath, [RUNNER, jet, '--env', 'dev', '--continue'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RESTCLIENT_SECRET_API_KEY: 'clave-123' } });
  let output = ''; p2.stdout.on('data', d => output += d); p2.on('close', exitCode => res({ exitCode, output }));
});
ok('el secreto también llega por RESTCLIENT_SECRET*', r9.exitCode === 0, r9.output.split(BR)[1] ?? '');
const r10 = await correr([jet, '--env', 'no-existe', '--secret', 'API_KEY=x', '--continue']);
ok('un entorno que no existe avisa, dice cuáles hay y no revienta', r10.exitCode !== 2 && r10.error.includes('--env no-existe: no such environment') && r10.error.includes('Available: dev'), r10.error.split(BR)[0]);

console.log(BR + '== streaming: SSE y WebSocket');
const sse = escribir('sse.http', [
  `GET http://127.0.0.1:${puerto}/sse`,
  '',
  '# @assert status == 200',
  '# @assert header.content-type contains event-stream',
  '# @assert sse.count == 3',
  '# @assert sse.first == {"delta":"Hola"}',
  '# @assert sse.last == [DONE]',
]);
const r12 = await correr([sse, '--timeout', '5000']);
ok('un text/event-stream se lee entero y sse.* funciona', r12.exitCode === 0, r12.output.trim().split(BR).slice(0, 3).join(' | '));
const ws = escribir('socket.http', [
  '# @timeout 700',
  `WEBSOCKET ws://127.0.0.1:${puerto}/socket`,
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
const r13 = await correr([ws, '--json']);
let d13 = null; try { d13 = JSON.parse(r13.output); } catch { /* abajo */ }
ok('WEBSOCKET: saludo, eco de dos mensajes y cierre por @timeout', r13.exitCode === 0 && d13?.steps?.[0]?.status === 101, (d13?.steps?.[0]?.assertions ?? []).filter(a => !a.passed).map(a => a.assertion + ' -> ' + a.actual).join(' | ') || r13.error.slice(0, 200));

console.log(BR + '== multiparte con fichero, cURL pegado y --junit');
fs.writeFileSync(path.join(tmp, 'adjunto.txt'), 'attachment content {{host}}');
const multi = escribir('multi.http', [
  `POST http://127.0.0.1:${puerto}/echo/subida`,
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
  `curl -X POST http://127.0.0.1:${puerto}/echo/curl \\`,
  "  -H 'X-Test: from-curl' \\",
  "  -d 'a=1'",
  '',
  '# @assert status == 200',
  '# @assert body.$.header == from-curl',
  '# @assert body.$.received == a=1',
]);
const junit = path.join(tmp, 'informe.xml');
const r14 = await correr([multi, '--var', `host=http://127.0.0.1:${puerto}`, '--json', '--junit', junit]);
let d14 = null; try { d14 = JSON.parse(r14.output); } catch { /* abajo */ }
const cuerpoMulti = d14?.steps?.[0] ? '' : r14.output.slice(0, 200);
ok('un multiparte con <@ fichero llega con el contenido y las variables sustituidas', r14.exitCode === 0 && d14?.steps?.[0]?.assertions?.every(a => a.passed), (d14?.steps?.[0]?.assertions ?? []).filter(a => !a.passed).map(a => a.assertion + ' -> ' + a.actual).join(' | ') || cuerpoMulti);
ok('una orden curl pegada se envía como curl lo haría', d14?.steps?.[1]?.assertions?.every(a => a.passed) === true, (d14?.steps?.[1]?.assertions ?? []).filter(a => !a.passed).map(a => a.assertion + ' -> ' + a.actual).join(' | '));
const xml = fs.existsSync(junit) ? fs.readFileSync(junit, 'utf8') : '';
ok('--junit escribe un informe con un caso por petición', xml.includes('tests="2" failures="0" errors="0"') && (xml.match(/<testcase /g) || []).length === 2, xml.slice(0, 120));
const r15 = await correr([malo, '--junit', junit]);
const xmlMalo = fs.readFileSync(junit, 'utf8');
ok('el informe recoge la aserción fallida', r15.exitCode === 1 && xmlMalo.includes('failures="1"') && xmlMalo.includes('<failure message="status == 200 -&gt; 404"/>'), xmlMalo.split(BR).find(l => l.includes('failure')) ?? '');

console.log(BR + '== errores de uso');
const r5 = await correr([]);
ok('sin fichero explica cómo se usa', r5.exitCode === 2 && r5.error.includes('usage:'));
const r6 = await correr([bueno, '--var', 'malescrita']);
ok('una variable mal escrita se rechaza', r6.exitCode === 2 && r6.error.includes('malformed variable: "malescrita"'), r6.error.trim());
const r11 = await correr([bueno, '--secret', 'sin-igual']);
ok('un secreto mal escrito se rechaza', r11.exitCode === 2 && r11.error.includes('malformed secret: "sin-igual"'), r11.error.trim());

// Una opción que el runner no conoce es un error, no un no-op: si se ignorase,
// un `--continuar` viejo en un CI pararía en la primera petición que no se
// puede enviar sin decir por qué. (Lo que detiene la secuencia es un error de
// envío; una aserción que falla no la detiene, con o sin --continue.)
console.log(BR + '== opciones desconocidas y --continue');
const dosPasos = escribir('dos.http', [
  `GET http://127.0.0.1:${puerto}/echo/x`,
  'X-Test: {{$secret NO_ESTA}}',
  '',
  '###',
  '',
  `GET http://127.0.0.1:${puerto}/facturas`,
  'Authorization: Bearer tok-123',
  '',
  '# @assert status == 200',
]);
const pasos = (r) => { try { return JSON.parse(r.output).steps.length; } catch { return -1; } };
const r16 = await correr([dosPasos, '--json']);
ok('sin --continue se para en la primera petición que da error', r16.exitCode === 1 && pasos(r16) === 1, `${pasos(r16)} pasos`);
const r17 = await correr([dosPasos, '--json', '--continue']);
ok('con --continue sigue hasta el final y aun así sale con 1', r17.exitCode === 1 && pasos(r17) === 2, `${pasos(r17)} pasos`);
const r18 = await correr([dosPasos, '--json', '--continuar']);
ok('el nombre antiguo --continuar se rechaza y dice el nuevo', r18.exitCode === 2 && r18.output === '' && r18.error.includes('unknown option --continuar') && r18.error.includes('--continue now'), r18.error.trim());
const r19 = await correr([bueno, '--no-existe']);
ok('una opción desconocida se rechaza sin enviar nada', r19.exitCode === 2 && r19.output === '' && r19.error.includes('unknown option --no-existe') && r19.error.includes('usage:'), r19.error.trim().split(BR)[0]);
// El servidor MCP: su raíz es el límite de lo que un agente puede leer, así que
// un argumento que no entiende lo para en vez de dejarlo en el directorio actual.
const r20 = await correr(['mcp', '--raiz', tmp]);
ok('mcp --raiz (nombre antiguo) no arranca y dice --root', r20.exitCode === 2 && r20.output === '' && r20.error.includes('--root now'), r20.error.trim());
const r21 = await correr(['mcp', '--root']);
ok('mcp --root sin carpeta no arranca', r21.exitCode === 2 && r21.error.includes('--root needs a folder'), r21.error.trim());
const r22 = await correr(['mcp', tmp]);
ok('mcp con un argumento suelto no arranca', r22.exitCode === 2 && r22.error.includes('unexpected argument'), r22.error.trim().split(BR)[0]);
const r26 = await correr(['mcp', '--root', '']);
ok('mcp --root vacío no arranca (una variable sin definir no ensancha la raíz)', r26.exitCode === 2 && r26.output === '' && r26.error.includes('--root needs a folder'), r26.error.trim());
const r27 = await correr(['mcp', '--root', tmp, '--root', tmp]);
ok('mcp con --root repetido no arranca', r27.exitCode === 2 && r27.output === '' && r27.error.includes('--root given twice'), r27.error.trim());
const dosFallos = escribir('dos-fallos.http', [
  `GET http://127.0.0.1:${puerto}/not-found`,
  '',
  '# @assert status == 200',
  '',
  '###',
  '',
  `GET http://127.0.0.1:${puerto}/not-found`,
  '',
  '# @assert status == 200',
]);
const r23 = await correr([dosFallos]);
ok('una aserción que falla no detiene la secuencia, y el resumen va en plural', r23.exitCode === 1 && r23.output.includes('2 requests, 2 failures'), r23.output.trim().split(BR).pop());
const r24 = await correr([malo, bueno]);
ok('dos ficheros se rechazan en vez de ejecutar solo el último', r24.exitCode === 2 && r24.output === '' && r24.error.includes('only one file per run, got 2'), r24.error.trim().slice(0, 40));
const r25 = await correr([bueno, '--junit', '--json']);
ok('una opción no vale como valor de otra', r25.exitCode === 2 && r25.output === '' && r25.error.includes('--junit needs the path of the XML report, got "--json"'), r25.error.trim());
const r28 = await correr(['--json', '--', bueno]);
ok('tras -- lo que sigue es el fichero', r28.exitCode === 0 && pasos(r28) === 2, `${pasos(r28)} pasos`);

hijo.kill();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${BR}===== ${failures} failures`);
process.exit(failures ? 1 : 0);
