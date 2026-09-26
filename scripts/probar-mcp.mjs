// Prueba del servidor MCP de punta a punta: arranca `restclient mcp` con una
// raíz, le habla por stdio como lo haría un agente y comprueba las respuestas.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUNNER = process.env.CLI_RUTA ?? 'dist-cli/cli/index.js';
const SERVIDOR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'servidor-pruebas.cjs');
const BR = String.fromCharCode(10);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-prueba-'));
const hijo = spawn(process.execPath, [SERVIDOR, '127.0.0.1'], { stdio: ['ignore', 'pipe', 'inherit'] });
const puerto = await new Promise((res, rej) => {
  hijo.stdout.once('data', d => res(JSON.parse(d.toString()).puerto));
  setTimeout(() => rej(new Error('el servidor no arrancó')), 8000);
});

fs.writeFileSync(path.join(tmp, 'http-client.env.json'), JSON.stringify({ dev: { host: `http://127.0.0.1:${puerto}` } }));
fs.writeFileSync(path.join(tmp, 'api.http'), [
  '# @name login', 'POST {{host}}/auth', 'Content-Type: application/json', '', '{"user":"ana"}', '', '# @assert status == 200', '',
  '###', '', '# @name facturas', 'GET {{host}}/facturas', 'Authorization: Bearer {{login.response.body.$.token}}', '', '# @assert body.$.total == 3', '',
  '###', '', 'GET {{host}}/eco/suelta', 'X-Prueba: {{$secret API_KEY}}', '',
].join(BR));
fs.writeFileSync(path.join(os.tmpdir(), 'fuera-de-raiz.http'), 'GET http://127.0.0.1/no');

const mcp = spawn(process.execPath, [RUNNER, 'mcp', '--raiz', tmp], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const pendientes = new Map();
mcp.stdout.on('data', d => {
  buffer += d;
  let corte;
  while ((corte = buffer.indexOf(BR)) >= 0) {
    const linea = buffer.slice(0, corte); buffer = buffer.slice(corte + 1);
    if (!linea.trim()) continue;
    const msg = JSON.parse(linea);
    pendientes.get(msg.id)?.(msg);
    pendientes.delete(msg.id);
  }
});
let errores = '';
mcp.stderr.on('data', d => errores += d);
let siguienteId = 1;
const llamar = (method, params) => new Promise((res, rej) => {
  const id = siguienteId++;
  pendientes.set(id, res);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + BR);
  setTimeout(() => { if (pendientes.has(id)) { pendientes.delete(id); rej(new Error(`sin respuesta a ${method}`)); } }, 15000);
});
const notificar = (method) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + BR);
const herramienta = async (name, args) => {
  const r = await llamar('tools/call', { name, arguments: args });
  let datos = null; try { datos = JSON.parse(r.result?.content?.[0]?.text ?? ''); } catch { datos = r.result?.content?.[0]?.text; }
  return { r, datos };
};

let fallos = 0;
const ok = (n, c, extra = '') => { console.log(`${c ? '  OK  ' : '  FALLA'} ${n}${extra ? ' · ' + extra : ''}`); if (!c) fallos++; };

console.log('== protocolo');
const init = await llamar('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'prueba', version: '1' } });
ok('initialize devuelve la versión del protocolo y el nombre', init.result?.protocolVersion === '2025-06-18' && init.result?.serverInfo?.name === 'restclient', JSON.stringify(init).slice(0, 120));
notificar('notifications/initialized');
const ping = await llamar('ping', {});
ok('ping', ping.result !== undefined && !ping.error);
const lista = await llamar('tools/list', {});
ok('tools/list anuncia las tres herramientas', (lista.result?.tools ?? []).map(t => t.name).sort().join(',') === 'list_requests,run_http_file,send_request');
const desconocido = await llamar('no/existe', {});
ok('un método desconocido da -32601', desconocido.error?.code === -32601);
mcp.stdin.write('esto no es json' + BR);
const roto = await new Promise(res => { pendientes.set(null, res); setTimeout(() => res(null), 3000); });
ok('un JSON roto da -32700 con id null', roto?.error?.code === -32700);

console.log(BR + '== herramientas');
const l = await herramienta('list_requests', { file: 'api.http' });
ok('list_requests lista nombre, método y URL sin enviar nada', l.datos?.requests?.length === 3 && l.datos.requests[0].nombre === 'login' && l.datos.requests[0].metodo === 'POST' && l.datos.requests[2].url === '{{host}}/eco/suelta', JSON.stringify(l.datos).slice(0, 160));
const s = await herramienta('send_request', { file: 'api.http', name: 'login', env: 'dev' });
ok('send_request envía una petición por su nombre', s.datos?.ok === true && s.datos?.pasos?.[0]?.estado === 200 && s.datos.pasos.length === 1, JSON.stringify(s.datos).slice(0, 160));
const r = await herramienta('run_http_file', { file: 'api.http', env: 'dev', secrets: { API_KEY: 'k' } });
ok('run_http_file ejecuta todo en orden, con las aserciones y la cadena', r.datos?.ok === true && r.datos?.pasos?.length === 3 && r.datos.pasos[1].aserciones[0].pasa === true, JSON.stringify(r.datos?.pasos?.map(p => [p.nombre, p.estado])));
const sinSecreto = await herramienta('run_http_file', { file: 'api.http', env: 'dev' });
ok('sin el secreto, isError y el mensaje que dice cuál', sinSecreto.r.result?.isError === true && JSON.stringify(sinSecreto.datos).includes('API_KEY'), JSON.stringify(sinSecreto.datos).slice(0, 120));
const fuera = await herramienta('list_requests', { file: '../fuera-de-raiz.http' });
ok('una ruta fuera de la raíz se rechaza', fuera.r.result?.isError === true && String(fuera.datos).includes('outside the allowed root'));
const noExiste = await herramienta('list_requests', { file: 'nada.http' });
ok('un fichero que no existe se dice', noExiste.r.result?.isError === true && String(noExiste.datos).includes('does not exist'));
const malaHerramienta = await llamar('tools/call', { name: 'borrar_todo', arguments: {} });
ok('una herramienta desconocida da -32602', malaHerramienta.error?.code === -32602);
ok('el servidor no escribió en stderr', errores.trim() === '', errores.slice(0, 120));
ok('la raíz sigue igual: el servidor no escribe en disco', fs.readdirSync(tmp).sort().join(',') === 'api.http,http-client.env.json');

mcp.kill();
hijo.kill();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${BR}===== ${fallos} fallos`);
process.exit(fallos ? 1 : 0);
