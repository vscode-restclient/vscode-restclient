// Empaqueta, INSTALA el .vsix en un VS Code limpio y lo prueba ahi.
//
// Todo lo demas se prueba contra el codigo fuente; esto se prueba contra lo que
// se sube a la tienda, que es lo unico que le llega al usuario. Tres fallos de
// esta version solo se veian asi: recursos que el manifiesto se dejaba fuera.
//
// Se arranca en castellano a proposito (--locale=es) para comprobar de paso que
// la traduccion viaja dentro del paquete.
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SERVIDOR = `const http = require('http');
const s = http.createServer((q, r) => {
  let b = ''; q.on('data', c => b += c);
  q.on('end', () => {
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end(JSON.stringify({ token: 'tok-123', recibido: b }));
  });
});
s.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ puerto: s.address().port })));`;

// En Windows npx es un .cmd y hay que pasar por el shell, asi que las rutas van
// entre comillas; en Linux y macOS no hay shell y las comillas irian literales.
const CON_SHELL = process.platform === 'win32';
const ruta = (r) => (CON_SHELL ? JSON.stringify(r) : r);
const correr = (cmd, args, opciones = {}) => {
    const r = cp.spawnSync(cmd, args, { encoding: 'utf8', shell: CON_SHELL, ...opciones });
    if (r.status !== 0) {
        console.error(r.stdout ?? '');
        console.error(r.stderr ?? '');
        throw new Error(`${path.basename(cmd)} salio con ${r.status}`);
    }
    return r.stdout ?? '';
};

async function main() {
    delete process.env.ELECTRON_RUN_AS_NODE;

    const vsix = path.join(os.tmpdir(), `restclient-prueba-${process.pid}.vsix`);
    console.log('empaquetando...');
    correr('npx', ['vsce', 'package', '--no-dependencies', '-o', ruta(vsix)], { cwd: RAIZ });
    console.log(`${(fs.statSync(vsix).size / 1024 / 1024).toFixed(2)} MB`);

    const ejecutable = await downloadAndUnzipVSCode();
    const [cli, ...argsCli] = resolveCliArgsFromVSCodeExecutablePath(ejecutable);

    const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-perfil-'));
    const extensiones = path.join(perfil, 'extensions');
    const datos = path.join(perfil, 'user-data');
    console.log('instalando en un VS Code limpio...');
    console.log(correr(ruta(cli), [...argsCli, '--extensions-dir', ruta(extensiones), '--user-data-dir', ruta(datos), '--install-extension', ruta(vsix)]).trim());

    const tmpServidor = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-srv-'));
    fs.writeFileSync(path.join(tmpServidor, 's.cjs'), SERVIDOR);
    const hijo = cp.spawn(process.execPath, [path.join(tmpServidor, 's.cjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
    const puerto = await new Promise((res, rej) => {
        hijo.stdout.once('data', (d) => res(JSON.parse(d.toString()).puerto));
        setTimeout(() => rej(new Error('el servidor no arranco')), 8000);
    });

    const trabajo = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-ws-'));
    try {
        await runTests({
            vscodeExecutablePath: ejecutable,
            extensionTestsPath: path.join(RAIZ, 'scripts', 'prueba-instalada.cjs'),
            launchArgs: [trabajo, '--extensions-dir', extensiones, '--user-data-dir', datos, '--locale=es', '--disable-workspace-trust'],
            extensionTestsEnv: { VSIX_PUERTO: String(puerto) },
        });
        console.log('\n===== el .vsix instalado pasa la prueba');
    } finally {
        hijo.kill();
        // VS Code suelta los ficheros con calma: si el perfil no se deja borrar,
        // se avisa y se sigue. No es motivo para dar la prueba por fallida.
        for (const d of [tmpServidor, trabajo, perfil, vsix]) {
            try { fs.rmSync(d, { recursive: true, force: true }); }
            catch { console.log(`no se pudo borrar ${d}; se queda ahi`); }
        }
    }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
