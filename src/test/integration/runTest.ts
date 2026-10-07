import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/** Starts a local test server and runs the suite against it. */
async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root = path.resolve(__dirname, '../../../');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-it-'));
  // The test server shared with the runner's suite (scripts/test-server.cjs):
  // echo, status codes, JSON, XML, a redirect, SSE and an echo WebSocket.
  const server = path.join(root, 'scripts', 'test-server.cjs');
  const hijo = cp.spawn(process.execPath, [server, '::1'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port: string = await new Promise((res, rej) => {
    hijo.stdout!.once('data', (d) => res(String(JSON.parse(d.toString()).port)));
    setTimeout(() => rej(new Error('the test server did not start')), 10000);
  });
  console.log(`test server on port ${port}`);

  // This plays someone who ALREADY had REST Client: their settings live in the
  // user's settings.json. VS Code does not let the API write them if no
  // installed extension declares the section, so the only faithful way to test
  // the inheritance is to have them in place beforehand.
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
      extensionTestsEnv: { RC_TEST_PUERTO: port, HK_SOLO: process.env.HK_SOLO ?? '' },
    });
  } finally {
    hijo.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('The integration tests failed', e);
  process.exit(1);
});
