import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const PORT = process.env.RC_TEST_PORT!;
const BASE = `http://[::1]:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const setting = (key: string, value: unknown) =>
  vscode.workspace.getConfiguration('rest-client').update(key, value, vscode.ConfigurationTarget.Global);

/** Opens a document (a file on disk, or untitled with `content`), sends it and waits for the response that carries `mark`. */
async function send(target: { file?: string; content?: string }, mark: string, seconds = 20): Promise<void> {
  const doc = target.file
    ? await vscode.workspace.openTextDocument(vscode.Uri.file(target.file))
    : await vscode.workspace.openTextDocument({ language: 'http', content: target.content });
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand('rest-client.request');
  for (let i = 0; i < seconds * 4; i++) {
    await wait(250);
    if (vscode.workspace.textDocuments.some((d) => d.uri.toString() !== doc.uri.toString() && d.getText().includes(mark))) {
      return;
    }
  }
  throw new Error(`no response with "${mark}" in ${seconds} s`);
}

/** The text of `file` once it contains `mark` (history is written after the response is shown), or what it has after 5 s. */
async function contentWith(file: string, mark: string): Promise<string> {
  let text = '';
  for (let i = 0; i < 20; i++) {
    text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (text.includes(mark)) {
      break;
    }
    await wait(250);
  }
  return text;
}

const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

// P-97: the selected environment is per window (workspaceState), inherited
// once from REST Client's shared file; `rest-client.dataLocation` decides
// where history, cookies and saved responses go.
describe('Rest Client · data location and per-window environment', () => {
  const home = process.env.VSC_REST_CLIENT_HOME!;
  let workspaceFolder: string;

  before(async () => {
    assert.ok(home, 'the runner sets VSC_REST_CLIENT_HOME');
    workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    assert.ok(workspaceFolder, 'the test needs an open workspace');
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    assert.ok(ext, 'the extension is not loaded');
    await ext!.activate();
    await setting('previewResponseInUntitledDocument', true);
    await setting('previewResponsePanelTakeFocus', false);
    await setting('environmentVariables', {
      'Inherited env': { inheritedPath: '/echo/inherited-from-rest-client' },
      workspaceEnv: { unused: 'x' },
    });
  });

  after(async () => {
    await setting('dataLocation', undefined);
    await vscode.commands.executeCommand('rest-client.switch-environment', '');
    await setting('environmentVariables', undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // On Windows the file watcher can hold the folder for a moment; the runner
    // deletes the whole workspace at the end anyway, and with `home` back
    // nothing reads this folder.
    try {
      fs.rmSync(path.join(workspaceFolder, '.rest-client'), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* left for the runner's cleanup */
    }
  });

  it('P-97 · the selection REST Client left in ~/.rest-client is inherited, and switching no longer writes that file', async function () {
    this.timeout(40000);
    // The runner wrote it before the window opened; no suite before this one switches.
    await send({ content: `GET ${BASE}{{inheritedPath}}\n` }, '/echo/inherited-from-rest-client');
    const legacy = path.join(home, 'environment.json');
    const before = read(legacy);
    await vscode.commands.executeCommand('rest-client.switch-environment', '');
    assert.strictEqual(read(legacy), before, 'the shared file is left as it was');
  });

  it('P-97 · workspace: history and cookies go to .rest-client in the folder of the .http file, with its .gitignore, and the selection is left for the runner', async function () {
    this.timeout(40000);
    await setting('dataLocation', 'workspace');
    const file = path.join(workspaceFolder, 'data-location', 'cookie.http');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `GET ${BASE}/cookie/set/ws-mark\n`);
    await send({ file }, 'ws-mark');

    const data = path.join(workspaceFolder, '.rest-client');
    assert.ok((await contentWith(path.join(data, 'history.json'), '/cookie/set/ws-mark')).includes('/cookie/set/ws-mark'), 'history in the workspace');
    assert.ok(read(path.join(data, 'cookie.json')).includes('rcmark'), 'the cookie in the workspace: ' + read(path.join(data, 'cookie.json')).slice(0, 200));
    assert.ok(read(path.join(data, '.gitignore')).split('\n').includes('*'), 'a .gitignore that ignores everything');
    assert.ok(!read(path.join(home, 'history.json')).includes('ws-mark'), 'nothing in the home history');
    assert.ok(!read(path.join(home, 'cookie.json')).includes('rcmark'), 'nothing in the home cookies');

    await vscode.commands.executeCommand('rest-client.switch-environment', 'workspaceEnv');
    const selection = JSON.parse(read(path.join(data, 'environment.json')) || '{}');
    assert.deepStrictEqual(selection, { name: 'workspaceEnv', label: 'workspaceEnv', scope: 'workspace' });

    // With an untitled document in front (where a response preview lands),
    // Clear Cookies acts on the project of the last request, not on home.
    const untitled = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'not a request' });
    await vscode.window.showTextDocument(untitled, { preview: false });
    await vscode.commands.executeCommand('rest-client.clear-cookies');
    assert.ok(!read(path.join(data, 'cookie.json')).includes('rcmark'), 'the project cookie is gone: ' + read(path.join(data, 'cookie.json')).slice(0, 200));
  });

  it('P-97 · leaving workspace mode removes the selection left for the runner and keeps the data', async function () {
    this.timeout(20000);
    const data = path.join(workspaceFolder, '.rest-client');
    assert.ok(fs.existsSync(path.join(data, 'environment.json')), 'the previous test left a selection');
    await setting('dataLocation', 'home');
    for (let i = 0; i < 20 && fs.existsSync(path.join(data, 'environment.json')); i++) {
      await wait(250);
    }
    assert.ok(!fs.existsSync(path.join(data, 'environment.json')), 'a selection the editor no longer keeps must not steer the runner');
    assert.ok(read(path.join(data, 'history.json')).includes('/cookie/set/ws-mark'), 'the history stays');
  });

  it('P-97 · shared: history goes to the folder VS Code gives the extension, not to home', async function () {
    this.timeout(40000);
    await setting('dataLocation', 'shared');
    // The user data dir outlives the run: a mark of this run, not one an earlier run left.
    const mark = `shared-mark-${Date.now()}`;
    await send({ content: `GET ${BASE}/echo/${mark}\n` }, `/echo/${mark}`);
    // <user-data-dir>/User/globalStorage/<extension id>; the user data dir is the one the runner passes.
    const globalStorage = path.resolve(__dirname, '../../../../.vscode-test/user-data/User/globalStorage');
    const folders = fs.readdirSync(globalStorage).filter((name) => name.toLowerCase() === 'vscode-restclient.restclient');
    assert.strictEqual(folders.length, 1, fs.readdirSync(globalStorage).join(', '));
    const history = await contentWith(path.join(globalStorage, folders[0], 'history.json'), mark);
    assert.ok(history.includes(mark), history.slice(0, 200));
    assert.ok(!read(path.join(home, 'history.json')).includes(mark), 'nothing in the home history');
    assert.ok(!fs.existsSync(path.join(globalStorage, folders[0], '.gitignore')), 'no .gitignore outside a project');
  });
});
