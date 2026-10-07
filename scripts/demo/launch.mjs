// Puts the whole demo together: local server, make-believe workspace, scripted
// VS Code and the window capturer running alongside.
//
// What comes out of here are raw frames in media/demo/. Picking the shots and
// assembling the GIF is assemble.mjs's job.
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT = path.join(ROOT, 'media', 'demo');

const SERVER = `const http = require('http');
const s = http.createServer((q, r) => {
  let b = ''; q.on('data', c => b += c);
  q.on('end', () => {
    const json = (codigo, cuerpo) => { r.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8' }); r.end(JSON.stringify(cuerpo, null, 2)); };
    if (q.url === '/entrar') return json(200, { token: 'eyJhbGciOiJIUzI1NiJ9.demo', expira_en: 3600, usuario: { id: 42, nombre: 'Ana Ferreiro', rol: 'admin' } });
    if (q.url.startsWith('/facturas/')) return json(200, { id: Number(q.url.split('/')[2]), estado: 'pagada' });
    if (q.url === '/facturas') {
      if (q.headers.authorization !== 'Bearer eyJhbGciOiJIUzI1NiJ9.demo') return json(401, { error: 'falta el token' });
      return json(200, { total: 3, facturas: [
        { id: 1001, cliente: 'Papelería Besbello', importe: 148.5, estado: 'pagada' },
        { id: 1002, cliente: 'CEIP Plurilingüe', importe: 2310, estado: 'pendiente' },
        { id: 1003, cliente: 'Argalla, S.L.', importe: 990, estado: 'pagada' } ] });
    }
    if (q.url === '/facturas' && q.method === 'POST') return json(201, { id: 1004 });
    if (q.url === '/chat') {
      // The way a model API answers: one event every 700 ms, so it can be seen arriving.
      r.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const trozos = ['Las', ' facturas', ' pendientes', ' suman', ' 2.310 €', ' (CEIP', ' Plurilingüe).'];
      let i = 0;
      const tic = setInterval(() => {
        if (i < trozos.length) r.write('data: {"delta":' + JSON.stringify(trozos[i++]) + '}\\n\\n');
        else { r.write('data: [DONE]\\n\\n'); clearInterval(tic); r.end(); }
      }, 700);
      return;
    }
    json(404, { error: 'no existe', ruta: q.url });
  });
});
s.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: s.address().port })));`;

const API_HTTP = (serverPort) => `@host = http://127.0.0.1:${serverPort}

# @name entrar
POST {{host}}/entrar
Content-Type: application/json

{
  "usuario": "ana",
  "clave": "{{$processEnv CLAVE_API}}"
}

###

# El token de la respuesta anterior se usa aquí. Sin copiar y pegar.
GET {{host}}/facturas
Authorization: Bearer {{entrar.response.body.$.token}}
Accept: application/json
`;

const TESTS_HTTP = (serverPort) => `@host = http://127.0.0.1:${serverPort}

# @name entrar
POST {{host}}/entrar
Content-Type: application/json

{ "usuario": "ana", "clave": "secreta" }

# @assert status == 200
# @assert body.$.token exists

###

GET {{host}}/facturas
Authorization: Bearer {{entrar.response.body.$.token}}

# @assert status == 200
# @assert body.$.total == 3
# @assert header.content-type contains json
`;

const CHAT_HTTP = (serverPort) => `@host = http://127.0.0.1:${serverPort}

# Una API de modelos responde en streaming: el panel pinta cada evento según llega.
POST {{host}}/chat
Content-Type: application/json

{ "prompt": "¿Cuánto suman las facturas pendientes?" }

# @assert sse.last == [DONE]
`;

const SETTINGS = {
    'workbench.colorTheme': 'Default Dark Modern',
    'editor.minimap.enabled': false,
    'breadcrumbs.enabled': false,
    'editor.fontSize': 15,
    'terminal.integrated.fontSize': 14,
    'editor.lineNumbers': 'on',
    'workbench.startupEditor': 'none',
    'window.commandCenter': false,
    'workbench.layoutControl.enabled': false,
    'editor.renderWhitespace': 'none',
    'rest-client.previewColumn': 'beside',
    'rest-client.fontSize': 14,
};

async function main() {
    // Without this, Electron starts as Node and treats the workspace folder as
    // a module to load.
    delete process.env.ELECTRON_RUN_AS_NODE;

    fs.rmSync(OUTPUT, { recursive: true, force: true });
    fs.mkdirSync(OUTPUT, { recursive: true });

    const serverTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-srv-'));
    const serverFile = path.join(serverTmp, 'servidor.cjs');
    fs.writeFileSync(serverFile, SERVER);
    const serverProcess = cp.spawn(process.execPath, [serverFile], { stdio: ['ignore', 'pipe', 'inherit'] });
    const serverPort = await new Promise((res, rej) => {
        serverProcess.stdout.once('data', (d) => res(JSON.parse(d.toString()).port));
        setTimeout(() => rej(new Error('the demo server did not start')), 8000);
    });
    console.log(`demo server on ${serverPort}`);

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-ws-'));
    fs.writeFileSync(path.join(work, 'api.http'), API_HTTP(serverPort));
    fs.writeFileSync(path.join(work, 'pruebas.http'), TESTS_HTTP(serverPort));
    fs.writeFileSync(path.join(work, 'chat.http'), CHAT_HTTP(serverPort));
    fs.mkdirSync(path.join(work, '.vscode'));
    fs.writeFileSync(path.join(work, '.vscode', 'settings.json'), JSON.stringify(SETTINGS, null, 2));

    const capturer = cp.spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(ROOT, 'scripts', 'demo', 'capture.ps1'),
        '-Salida', OUTPUT,
    ], { stdio: 'inherit' });

    try {
        await runTests({
            extensionDevelopmentPath: ROOT,
            extensionTestsPath: path.join(ROOT, 'scripts', 'demo', 'script.cjs'),
            launchArgs: [
                work,
                `--user-data-dir=${path.join(ROOT, '.vscode-test', 'demo-user-data')}`,
                '--disable-extensions',
                '--disable-workspace-trust',
            ],
            extensionTestsEnv: {
                DEMO_SALIDA: OUTPUT,
                DEMO_PUERTO: String(serverPort),
                DEMO_CLI: path.join(ROOT, 'dist', 'cli.js'),
                CLAVE_API: 'no-es-una-clave-de-verdad',
            },
        });
    } finally {
        fs.writeFileSync(path.join(OUTPUT, 'fin.txt'), 'listo');
        serverProcess.kill();
        await new Promise((r) => capturer.on('close', r));
        fs.rmSync(serverTmp, { recursive: true, force: true });
        fs.rmSync(work, { recursive: true, force: true });
    }

    const frames = fs.readdirSync(OUTPUT).filter((f) => /^f\d+\.png$/.test(f)).length;
    console.log(`${frames} frames in ${OUTPUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
