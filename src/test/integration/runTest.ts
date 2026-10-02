import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/** Levanta un servidor de prueba local y corre la suite contra él. */
async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root = path.resolve(__dirname, '../../../');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-it-'));
  // Servidor de pruebas compartido con la suite del runner (scripts/test-server.cjs):
  // eco, códigos de estado, JSON, XML, redirección, SSE y un WebSocket de eco.
  const server = path.join(root, 'scripts', 'servidor-pruebas.cjs');
  const hijo = cp.spawn(process.execPath, [server, '::1'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const puerto: string = await new Promise((res, rej) => {
    hijo.stdout!.once('data', (d) => res(String(JSON.parse(d.toString()).puerto)));
    setTimeout(() => rej(new Error('el servidor de prueba no arrancó')), 10000);
  });
  console.log(`servidor de prueba en el puerto ${puerto}`);

  // Se simula a alguien que YA tenía REST Client: sus ajustes viven en el
  // settings.json del usuario. VS Code no deja escribirlos desde la API si la
  // sección no está declarada por ninguna extensión instalada, así que la única
  // forma fiel de probar la herencia es dejarlos puestos de antemano.
  const userDir = path.join(root, '.vscode-test', 'user-data', 'User');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDir, 'settings.json'),
    JSON.stringify({ 'rest-client.defaultHeaders': { 'User-Agent': 'viene-de-restclient' } }, null, 2),
  );

  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.resolve(__dirname, './suite/index'),
      launchArgs: [tmp, `--user-data-dir=${path.join(root, '.vscode-test', 'user-data')}`, '--disable-extensions'],
      extensionTestsEnv: { RC_TEST_PUERTO: puerto, HK_SOLO: process.env.HK_SOLO ?? '' },
    });
  } finally {
    hijo.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('Fallaron las pruebas de integración', e);
  process.exit(1);
});
