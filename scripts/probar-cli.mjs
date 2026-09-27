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
const servidor = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'servidor-pruebas.cjs');
const hijo = spawn(process.execPath, [servidor, '127.0.0.1'], { stdio: ['ignore', 'pipe', 'inherit'] });
const puerto = await new Promise((res, rej) => {
  hijo.stdout.once('data', d => res(JSON.parse(d.toString()).puerto));
  setTimeout(() => rej(new Error('el servidor no arrancó')), 8000);
});

const BR = String.fromCharCode(10);
const escribir = (nombre, lineas) => {
  const f = path.join(tmp, nombre);
  fs.writeFileSync(f, lineas.join(BR) + BR);
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
  `GET http://127.0.0.1:${puerto}/no-existe`,
  '',
  '# @assert status == 200',
]);

const correr = (args) => new Promise((res) => {
  const p = spawn(process.execPath, [RUNNER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let salida = '', error = '';
  p.stdout.on('data', d => salida += d);
  p.stderr.on('data', d => error += d);
  p.on('close', codigo => res({ codigo, salida, error }));
});

let fallos = 0;
const ok = (n, c, extra = '') => { console.log(`${c ? '  OK  ' : '  FALLA'} ${n}${extra ? ' · ' + extra : ''}`); if (!c) fallos++; };

console.log('== P-23 · el fichero completo, con dos peticiones encadenadas');
const r1 = await correr([bueno]);
console.log(r1.salida.trim().split(BR).map(l => '     ' + l).join(BR));
ok('sale con código 0 cuando todo pasa', r1.codigo === 0, `código ${r1.codigo}`);
ok('ejecuta las dos peticiones', (r1.salida.match(/ok /g) || []).length === 2);
ok('el token de la primera llega a la segunda', r1.salida.includes('facturas') && !r1.salida.includes('FALLA'));

console.log(BR + '== P-23 · una aserción que falla');
const r2 = await correr([malo]);
ok('sale con código 1', r2.codigo === 1, `código ${r2.codigo}`);
ok('dice qué aserción falló y con qué valor', r2.salida.includes('status == 200') && r2.salida.includes('404'));

console.log(BR + '== salida en JSON, para integración continua');
const r3 = await correr([bueno, '--json']);
let datos = null;
try { datos = JSON.parse(r3.salida); } catch { /* se reporta abajo */ }
ok('la salida es JSON válido', datos !== null);
ok('trae un paso por petición con sus aserciones', datos?.pasos?.length === 2 && datos.pasos[1].aserciones.length === 5);
ok('las aserciones sobre cabeceras y tiempo pasan', datos?.pasos?.[1]?.aserciones?.every(a => a.pasa === true) === true,
  (datos?.pasos?.[1]?.aserciones ?? []).filter(a => !a.pasa).map(a => a.asercion?.crudo ?? '?').join(' | '));
ok('cada aserción dice si pasa', datos?.pasos?.[0]?.aserciones?.every(a => a.pasa === true) === true);

console.log(BR + '== variables desde la línea de órdenes');
const conVar = escribir('var.http', ['GET {{destino}}/facturas', 'Authorization: Bearer tok-123', '', '# @assert status == 200']);
const r4 = await correr([conVar, '--var', `destino=http://127.0.0.1:${puerto}`]);
ok('--var sustituye la variable', r4.codigo === 0, r4.salida.trim().split(BR)[0]);

console.log(BR + '== formato JetBrains: entornos de fichero, import, run y secretos');
fs.writeFileSync(path.join(tmp, 'http-client.env.json'), JSON.stringify({ dev: { host: `http://127.0.0.1:${puerto}`, ruta: '/eco/publico' } }));
fs.writeFileSync(path.join(tmp, 'http-client.private.env.json'), JSON.stringify({ dev: { ruta: '/eco/privado' } }));
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
  'GET {{host}}{{ruta}}',
  'X-Prueba: {{$secret API_KEY}}-{{$random.integer(5,6)}}',
  '',
  '# @assert body.$.ruta == /eco/privado',
  '# @assert body.$.cabecera == clave-123-5',
  '',
  '###',
  '',
  'GET {{host}}/facturas',
  'Authorization: Bearer {{login.response.body.$.token}}',
  '',
  '# @assert status == 200',
]);
const r7 = await correr([jet, '--env', 'dev', '--secret', 'API_KEY=clave-123', '--json']);
let d7 = null; try { d7 = JSON.parse(r7.salida); } catch { /* abajo */ }
ok('--env lee el entorno de http-client.env.json y el privado manda', r7.codigo === 0 && d7?.pasos?.[1]?.aserciones?.every(a => a.pasa), r7.salida.slice(0, 300));
ok('run #login ejecuta la petición importada con su nombre', d7?.pasos?.[0]?.nombre === 'login' && d7?.pasos?.[0]?.estado === 200);
ok('la respuesta del importado encadena en el fichero que importa', d7?.pasos?.[2]?.estado === 200);
const r8 = await correr([jet, '--env', 'dev']);
ok('sin el secreto, error que dice cuál y cómo pasarlo', r8.codigo === 1 && r8.salida.includes('falta el secreto "API_KEY"') && r8.salida.includes('RESTCLIENT_SECRET_API_KEY'), r8.salida.split(BR).find(l => l.includes('secreto')) ?? '');
const r9 = await new Promise((res) => {
  const p2 = spawn(process.execPath, [RUNNER, jet, '--env', 'dev', '--continuar'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RESTCLIENT_SECRET_API_KEY: 'clave-123' } });
  let salida = ''; p2.stdout.on('data', d => salida += d); p2.on('close', codigo => res({ codigo, salida }));
});
ok('el secreto también llega por RESTCLIENT_SECRET*', r9.codigo === 0, r9.salida.split(BR)[1] ?? '');
const r10 = await correr([jet, '--env', 'no-existe', '--secret', 'API_KEY=x', '--continuar']);
ok('un entorno que no existe avisa y no revienta', r10.codigo !== 2 && r10.error.includes('--env no-existe'), r10.error.split(BR)[0]);

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
ok('un text/event-stream se lee entero y sse.* funciona', r12.codigo === 0, r12.salida.trim().split(BR).slice(0, 3).join(' | '));
const ws = escribir('socket.http', [
  '# @timeout 700',
  `WEBSOCKET ws://127.0.0.1:${puerto}/socket`,
  'X-Prueba: ana',
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
let d13 = null; try { d13 = JSON.parse(r13.salida); } catch { /* abajo */ }
ok('WEBSOCKET: saludo, eco de dos mensajes y cierre por @timeout', r13.codigo === 0 && d13?.pasos?.[0]?.estado === 101, (d13?.pasos?.[0]?.aserciones ?? []).filter(a => !a.pasa).map(a => a.asercion + ' -> ' + a.obtenido).join(' | ') || r13.error.slice(0, 200));

console.log(BR + '== multiparte con fichero, cURL pegado y --junit');
fs.writeFileSync(path.join(tmp, 'adjunto.txt'), 'contenido del adjunto {{host}}');
const multi = escribir('multi.http', [
  `POST http://127.0.0.1:${puerto}/eco/subida`,
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
  '# @assert body.$.recibido contains contenido del adjunto http://127.0.0.1',
  '',
  '###',
  '',
  `curl -X POST http://127.0.0.1:${puerto}/eco/curl \\`,
  "  -H 'X-Prueba: desde-curl' \\",
  "  -d 'a=1'",
  '',
  '# @assert status == 200',
  '# @assert body.$.cabecera == desde-curl',
  '# @assert body.$.recibido == a=1',
]);
const junit = path.join(tmp, 'informe.xml');
const r14 = await correr([multi, '--var', `host=http://127.0.0.1:${puerto}`, '--json', '--junit', junit]);
let d14 = null; try { d14 = JSON.parse(r14.salida); } catch { /* abajo */ }
const cuerpoMulti = d14?.pasos?.[0] ? '' : r14.salida.slice(0, 200);
ok('un multiparte con <@ fichero llega con el contenido y las variables sustituidas', r14.codigo === 0 && d14?.pasos?.[0]?.aserciones?.every(a => a.pasa), (d14?.pasos?.[0]?.aserciones ?? []).filter(a => !a.pasa).map(a => a.asercion + ' -> ' + a.obtenido).join(' | ') || cuerpoMulti);
ok('una orden curl pegada se envía como curl lo haría', d14?.pasos?.[1]?.aserciones?.every(a => a.pasa) === true, (d14?.pasos?.[1]?.aserciones ?? []).filter(a => !a.pasa).map(a => a.asercion + ' -> ' + a.obtenido).join(' | '));
const xml = fs.existsSync(junit) ? fs.readFileSync(junit, 'utf8') : '';
ok('--junit escribe un informe con un caso por petición', xml.includes('tests="2" failures="0" errors="0"') && (xml.match(/<testcase /g) || []).length === 2, xml.slice(0, 120));
const r15 = await correr([malo, '--junit', junit]);
const xmlMalo = fs.readFileSync(junit, 'utf8');
ok('el informe recoge la aserción fallida', r15.codigo === 1 && xmlMalo.includes('failures="1"') && xmlMalo.includes('<failure message="status == 200 -&gt; 404"/>'), xmlMalo.split(BR).find(l => l.includes('failure')) ?? '');

console.log(BR + '== errores de uso');
const r5 = await correr([]);
ok('sin fichero explica cómo se usa', r5.codigo === 2 && r5.error.includes('uso:'));
const r6 = await correr([bueno, '--var', 'malescrita']);
ok('una variable mal escrita se rechaza', r6.codigo === 2 && r6.error.includes('clave=valor'));
const r11 = await correr([bueno, '--secret', 'sin-igual']);
ok('un secreto mal escrito se rechaza', r11.codigo === 2 && r11.error.includes('clave=valor'));

hijo.kill();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${BR}===== ${fallos} fallos`);
process.exit(fallos ? 1 : 0);
