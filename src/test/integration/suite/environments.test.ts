import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const PORT = process.env.RC_TEST_PORT!;
const BASE = `http://[::1]:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const setting = (key: string, value: unknown) =>
  vscode.workspace.getConfiguration('rest-client').update(key, value, vscode.ConfigurationTarget.Global);

/** Opens a .http document, runs Send Request and returns the response that carries `mark`. */
async function send(content: string, mark: string, seconds = 20): Promise<string> {
  const doc = await vscode.workspace.openTextDocument({ language: 'http', content });
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand('rest-client.request');
  for (let i = 0; i < seconds * 4; i++) {
    await wait(250);
    const response = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() !== doc.uri.toString() && d.getText().includes(mark),
    );
    if (response) return response.getText();
  }
  const open = vscode.workspace.textDocuments.map((d) => `${d.languageId}:${d.getText().slice(0, 80)}`).join(' | ');
  throw new Error(`no response with "${mark}" in ${seconds} s. Documents: ${open}`);
}

// #52: `rest-client.environmentVariables` from the user settings, with a
// `$shared` block, an environment whose name has spaces and brackets, and a
// `{{$shared x}}` reference, exactly as the report shows them. The selected
// environment lives in environment.json under VSC_REST_CLIENT_HOME, which the
// runner points at a folder of its own so the tests never touch ~/.rest-client.
describe('Rest Client · environments from the settings', () => {
  const ENV = 'Dev environment (Administrator)';
  const home = process.env.VSC_REST_CLIENT_HOME!;

  before(async () => {
    assert.ok(home, 'the runner sets VSC_REST_CLIENT_HOME');
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    assert.ok(ext, 'the extension is not loaded');
    await ext!.activate();
    await setting('previewResponseInUntitledDocument', true);
    await setting('previewResponsePanelTakeFocus', false);
    await setting('environmentVariables', {
      $shared: { devBaseUrl: `${BASE}/echo/dev`, liveBaseUrl: `${BASE}/echo/live` },
      [ENV]: { baseUrl: '{{$shared devBaseUrl}}', adminUsername: 'myUsername' },
    });
  });

  after(async () => {
    await setting('environmentVariables', undefined);
    fs.rmSync(path.join(home, 'environment.json'), { force: true });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('P-93 · with the environment selected, a variable that references $shared resolves and the request goes out', async function () {
    this.timeout(40000);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'environment.json'), JSON.stringify({ name: ENV, label: ENV }));
    const text = await send(`GET {{baseUrl}}/login?user={{adminUsername}}\n`, '/echo/dev/login');
    assert.ok(text.includes('user=myUsername'), 'the environment variable reached the server: ' + text.slice(0, 200));
  });

  it('P-94 · with no environment selected, the $shared variables still resolve', async function () {
    this.timeout(40000);
    fs.rmSync(path.join(home, 'environment.json'), { force: true });
    const text = await send(`GET {{devBaseUrl}}/shared-only\n`, '/echo/dev/shared-only');
    assert.ok(text.includes('/echo/dev/shared-only'), text.slice(0, 200));
  });
});
