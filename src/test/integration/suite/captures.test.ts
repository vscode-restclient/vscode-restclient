import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
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
  throw new Error(`no response with "${mark}" in ${seconds} s`);
}

/** What the echo server saw in X-Test, from its answer. */
const echoedHeader = (text: string) => /"header":\s*("[^"]*"|null)/.exec(text)?.[1];

// P-98: `# @set` in the editor. The value is taken in one document and used
// in another, takes the place of the environment's value, and belongs to the
// environment selected when it was taken. The names are this test's own, so
// nothing else in the run can see them.
describe('Rest Client · # @set', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    assert.ok(ext, 'the extension is not loaded');
    await ext!.activate();
    await setting('previewResponseInUntitledDocument', true);
    await setting('previewResponsePanelTakeFocus', false);
    await setting('environmentVariables', {
      'p98-a': { p98token: 'stale-a' },
      'p98-b': { p98token: 'stale-b' },
    });
    await vscode.commands.executeCommand('rest-client.switch-environment', 'p98-a');
  });

  after(async () => {
    await vscode.commands.executeCommand('rest-client.switch-environment', '');
    await setting('environmentVariables', undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('P-98 · a value taken in one document reaches a request in another, over the environment\'s value', async function () {
    this.timeout(60000);
    await send(`# @set p98token = response.body.$.header\nGET ${BASE}/echo/p98-login-1\nX-Test: captured-a\n`, 'p98-login-1');
    const used = await send(`GET ${BASE}/echo/p98-use-1\nX-Test: {{p98token}}\n`, 'p98-use-1');
    assert.strictEqual(echoedHeader(used), '"captured-a"', used.slice(0, 300));
  });

  it('P-98 · another environment does not see it, and the first one still has it', async function () {
    this.timeout(60000);
    await vscode.commands.executeCommand('rest-client.switch-environment', 'p98-b');
    const other = await send(`GET ${BASE}/echo/p98-use-2\nX-Test: {{p98token}}\n`, 'p98-use-2');
    assert.strictEqual(echoedHeader(other), '"stale-b"', other.slice(0, 300));
    await vscode.commands.executeCommand('rest-client.switch-environment', 'p98-a');
    const back = await send(`GET ${BASE}/echo/p98-use-3\nX-Test: {{p98token}}\n`, 'p98-use-3');
    assert.strictEqual(echoedHeader(back), '"captured-a"', back.slice(0, 300));
  });

  it('P-98 · a # @set that finds nothing leaves the value it had', async function () {
    this.timeout(60000);
    await send(`# @set p98token = response.body.$.nope\nGET ${BASE}/echo/p98-login-2\nX-Test: other\n`, 'p98-login-2');
    const used = await send(`GET ${BASE}/echo/p98-use-4\nX-Test: {{p98token}}\n`, 'p98-use-4');
    assert.strictEqual(echoedHeader(used), '"captured-a"', used.slice(0, 300));
  });

  it('P-98 · a {{name}} that a # @set of the same file takes is information, not an error, until its request answers', async function () {
    this.timeout(60000);
    // The diagnostics look at files on disk only.
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-p98-'));
    const file = path.join(folder, 'later.http');
    fs.writeFileSync(file, `# @name first\n# @set p98later = response.body.$.path\nGET ${BASE}/echo/p98-later\n\n###\n\nGET ${BASE}/echo{{p98later}}\nX-Test: {{p98nobody}}\n`);
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc, { preview: false });
    const about = (name: string) => vscode.languages.getDiagnostics(doc.uri).find((d) => d.message.includes(name));
    const all = () => vscode.languages.getDiagnostics(doc.uri).map((d) => `${d.severity} ${d.message}`).join(' | ');
    for (let i = 0; i < 40 && !(about('p98later') && about('p98nobody')); i++) {
      await wait(250);
    }
    assert.strictEqual(about('p98later')?.severity, vscode.DiagnosticSeverity.Information, all());
    assert.strictEqual(about('p98nobody')?.severity, vscode.DiagnosticSeverity.Error, all());

    // Once the request that sets it has answered, it is a variable like any other.
    await vscode.commands.executeCommand('rest-client.request');
    for (let i = 0; i < 80 && about('p98later'); i++) {
      await wait(250);
    }
    assert.strictEqual(about('p98later'), undefined, all());
    assert.strictEqual(about('p98nobody')?.severity, vscode.DiagnosticSeverity.Error, all());
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    fs.rmSync(folder, { recursive: true, force: true });
  });
});
