// Monta la demo entera: servidor local, carpeta de trabajo de mentira, VS Code
// guionizado y el capturador de ventana en paralelo.
//
// Lo que sale de aqui son fotogramas crudos en media/demo/. Elegir los planos y
// montar el GIF es cosa de montar.mjs.
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SALIDA = path.join(RAIZ, 'media', 'demo');

const SERVIDOR = `const http = require('http');
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
      // Como responde una API de modelos: un evento cada 700 ms, para que se vea llegar.
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
s.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ puerto: s.address().port })));`;

const API_HTTP = (puerto) => `@host = http://127.0.0.1:${puerto}

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

const PRUEBAS_HTTP = (puerto) => `@host = http://127.0.0.1:${puerto}

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

const CHAT_HTTP = (puerto) => `@host = http://127.0.0.1:${puerto}

# Una API de modelos responde en streaming: el panel pinta cada evento según llega.
POST {{host}}/chat
Content-Type: application/json

{ "prompt": "¿Cuánto suman las facturas pendientes?" }

# @assert sse.last == [DONE]
`;

const AJUSTES = {
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
    // Sin esto, Electron arranca como Node y trata la carpeta de trabajo como
    // si fuera un modulo que cargar.
    delete process.env.ELECTRON_RUN_AS_NODE;

    fs.rmSync(SALIDA, { recursive: true, force: true });
    fs.mkdirSync(SALIDA, { recursive: true });

    const tmpServidor = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-srv-'));
    const ficheroServidor = path.join(tmpServidor, 'servidor.cjs');
    fs.writeFileSync(ficheroServidor, SERVIDOR);
    const hijo = cp.spawn(process.execPath, [ficheroServidor], { stdio: ['ignore', 'pipe', 'inherit'] });
    const puerto = await new Promise((res, rej) => {
        hijo.stdout.once('data', (d) => res(JSON.parse(d.toString()).puerto));
        setTimeout(() => rej(new Error('el servidor de la demo no arrancó')), 8000);
    });
    console.log(`servidor de la demo en ${puerto}`);

    const trabajo = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-ws-'));
    fs.writeFileSync(path.join(trabajo, 'api.http'), API_HTTP(puerto));
    fs.writeFileSync(path.join(trabajo, 'pruebas.http'), PRUEBAS_HTTP(puerto));
    fs.writeFileSync(path.join(trabajo, 'chat.http'), CHAT_HTTP(puerto));
    fs.mkdirSync(path.join(trabajo, '.vscode'));
    fs.writeFileSync(path.join(trabajo, '.vscode', 'settings.json'), JSON.stringify(AJUSTES, null, 2));

    const capturador = cp.spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(RAIZ, 'scripts', 'demo', 'capturar.ps1'),
        '-Salida', SALIDA,
    ], { stdio: 'inherit' });

    try {
        await runTests({
            extensionDevelopmentPath: RAIZ,
            extensionTestsPath: path.join(RAIZ, 'scripts', 'demo', 'guion.cjs'),
            launchArgs: [
                trabajo,
                `--user-data-dir=${path.join(RAIZ, '.vscode-test', 'demo-user-data')}`,
                '--disable-extensions',
                '--disable-workspace-trust',
            ],
            extensionTestsEnv: {
                DEMO_SALIDA: SALIDA,
                DEMO_PUERTO: String(puerto),
                DEMO_CLI: path.join(RAIZ, 'dist', 'cli.js'),
                CLAVE_API: 'no-es-una-clave-de-verdad',
            },
        });
    } finally {
        fs.writeFileSync(path.join(SALIDA, 'fin.txt'), 'listo');
        hijo.kill();
        await new Promise((r) => capturador.on('close', r));
        fs.rmSync(tmpServidor, { recursive: true, force: true });
        fs.rmSync(trabajo, { recursive: true, force: true });
    }

    const fotogramas = fs.readdirSync(SALIDA).filter((f) => /^f\d+\.png$/.test(f)).length;
    console.log(`${fotogramas} fotogramas en ${SALIDA}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
