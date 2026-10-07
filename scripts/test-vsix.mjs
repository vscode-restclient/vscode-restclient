// Packages, INSTALLS the .vsix into a clean VS Code and tests it there.
//
// Everything else is tested against the source; this is tested against what
// goes to the store, which is the only thing that reaches the user. Three
// failures of this version could only be seen this way: resources the manifest
// left out.
//
// It starts in Spanish on purpose (--locale=es) to check along the way that the
// translation ships inside the package.
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SERVER = `const http = require('http');
const s = http.createServer((q, r) => {
  let b = ''; q.on('data', c => b += c);
  q.on('end', () => {
    r.writeHead(200, { 'content-type': 'application/json' });
    r.end(JSON.stringify({ token: 'tok-123', received: b }));
  });
});
s.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: s.address().port })));`;

// On Windows npx is a .cmd and has to go through the shell, so paths are
// quoted; on Linux and macOS there is no shell and the quotes would be literal.
const WITH_SHELL = process.platform === 'win32';
const filePath = (r) => (WITH_SHELL ? JSON.stringify(r) : r);
const run = (cmd, args, options = {}) => {
    const r = cp.spawnSync(cmd, args, { encoding: 'utf8', shell: WITH_SHELL, ...options });
    if (r.status !== 0) {
        console.error(r.stdout ?? '');
        console.error(r.stderr ?? '');
        throw new Error(`${path.basename(cmd)} exited with ${r.status}`);
    }
    return r.stdout ?? '';
};

async function main() {
    delete process.env.ELECTRON_RUN_AS_NODE;

    const vsix = path.join(os.tmpdir(), `restclient-test-${process.pid}.vsix`);
    console.log('packaging...');
    run('npx', ['vsce', 'package', '--no-dependencies', '-o', filePath(vsix)], { cwd: ROOT });
    console.log(`${(fs.statSync(vsix).size / 1024 / 1024).toFixed(2)} MB`);

    const executable = await downloadAndUnzipVSCode();
    const [cli, ...argsCli] = resolveCliArgsFromVSCodeExecutablePath(executable);

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-profile-'));
    const extensions = path.join(profile, 'extensions');
    const data = path.join(profile, 'user-data');
    console.log('installing into a clean VS Code...');
    console.log(run(filePath(cli), [...argsCli, '--extensions-dir', filePath(extensions), '--user-data-dir', filePath(data), '--install-extension', filePath(vsix)]).trim());

    const serverTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-srv-'));
    fs.writeFileSync(path.join(serverTmp, 's.cjs'), SERVER);
    const serverProcess = cp.spawn(process.execPath, [path.join(serverTmp, 's.cjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
    const serverPort = await new Promise((res, rej) => {
        serverProcess.stdout.once('data', (d) => res(JSON.parse(d.toString()).port));
        setTimeout(() => rej(new Error('the server did not start')), 8000);
    });

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-ws-'));
    try {
        await runTests({
            vscodeExecutablePath: executable,
            extensionTestsPath: path.join(ROOT, 'scripts', 'test-installed.cjs'),
            launchArgs: [work, '--extensions-dir', extensions, '--user-data-dir', data, '--locale=es', '--disable-workspace-trust'],
            extensionTestsEnv: { VSIX_PORT: String(serverPort) },
        });
        console.log('\n===== the installed .vsix passes the test');
    } finally {
        serverProcess.kill();
        // VS Code lets go of its files slowly: if the profile cannot be deleted,
        // say so and carry on. It is no reason to fail the test.
        for (const d of [serverTmp, work, profile, vsix]) {
            try { fs.rmSync(d, { recursive: true, force: true }); }
            catch { console.log(`could not delete ${d}; it stays there`); }
        }
    }
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
