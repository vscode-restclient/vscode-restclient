import * as assert from 'assert';
import * as vscode from 'vscode';

const PORT = process.env.RC_TEST_PORT!;
const BASE = `http://[::1]:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens a .http, sends it and returns the response text, or `undefined` if none shows up in the time given. */
async function trySend(content: string, mark: string, seconds = 20): Promise<string | undefined> {
  const doc = await vscode.workspace.openTextDocument({ language: 'http', content });
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand('rest-client.request');
  for (let i = 0; i < seconds * 4; i++) {
    await wait(250);
    const response = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() !== doc.uri.toString() && d.getText().startsWith('HTTP/') && d.getText().includes(mark),
    );
    if (response) return response.getText();
  }
  return undefined;
}

/** What the echo server saw in X-Test. */
const echoedHeader = (text: string | undefined) => JSON.parse(/"header":\s*("(?:[^"\\]|\\.)*"|null)/.exec(text ?? '')?.[1] ?? 'null');

// P-99: file variables in the editor resolve in one pass. What a reference
// puts in place (an environment value, a response, a value `# @set` took) is
// never read again for `{{…}}`, and a value is inserted as it is, `$` included.
describe('Rest Client · file variables, one pass', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    assert.ok(ext, 'the extension is not loaded');
    await ext!.activate();
    await vscode.workspace.getConfiguration('rest-client').update('previewResponseInUntitledDocument', true, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('rest-client').update('showResponseInDifferentTab', true, vscode.ConfigurationTarget.Global);
  });

  after(async () => {
    await vscode.workspace.getConfiguration('rest-client').update('showResponseInDifferentTab', undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('P-99 · a value a # @set took that carries {{fileVariable}} is not expanded through another file variable', async function () {
    this.timeout(60000);
    // The server answers with the text `{{p99pw}}`, and the login keeps it.
    const login = await trySend(`# @allow-unresolved\n# @set p99tok = response.body.$.header\nGET ${BASE}/echo/p99-login\nX-Test: {{p99pw}}\n`, 'p99-login');
    assert.strictEqual(echoedHeader(login), '{{p99pw}}', (login ?? 'no response').slice(0, 300));

    const use = (extra: string, mark: string) => `${extra}@p99pw = s3cret\n@p99auth = Bearer {{p99tok}}\nGET ${BASE}/echo/${mark}\nX-Test: {{p99auth}}\n`;
    const refused = await trySend(use('', 'p99-refused'), 'p99-refused', 5);
    assert.strictEqual(refused, undefined, `it went out, and the file's p99pw with it:\n${(refused ?? '').slice(0, 300)}`);
    const asIs = await trySend(use('# @allow-unresolved\n', 'p99-as-is'), 'p99-as-is');
    assert.strictEqual(echoedHeader(asIs), 'Bearer {{p99pw}}', (asIs ?? 'no response').slice(0, 300));
  });

  it('P-99 · a value with $& or $1 reaches the request as written, through another file variable', async function () {
    this.timeout(60000);
    const t = await trySend(`@p99a = x$&y$1z$$\n@p99b = <{{p99a}}>\nGET ${BASE}/echo/p99-dollar\nX-Test: {{p99b}}\n`, 'p99-dollar');
    assert.strictEqual(echoedHeader(t), '<x$&y$1z$$>', (t ?? 'no response').slice(0, 300));
  });

  it('P-99 · {{$guid}} in a file variable is one value wherever it ends up, directly or through another variable', async function () {
    this.timeout(60000);
    const t = await trySend(`@p99id = {{$guid}}\n@p99pair = {{p99id}}-{{p99id}}\nGET ${BASE}/echo/p99-guid/{{p99id}}\nX-Test: {{p99pair}}\n`, 'p99-guid');
    const id = /p99-guid\/([0-9a-f-]{36})/.exec(t ?? '')?.[1];
    assert.ok(id, (t ?? 'no response').slice(0, 300));
    assert.strictEqual(echoedHeader(t), `${id}-${id}`);
  });

  it('P-99 · chains of file variables still resolve, in any order of definition', async function () {
    this.timeout(60000);
    const t = await trySend(`@p99url = {{p99host}}/echo/p99-chain/{{p99leaf}}\n@p99host = ${BASE}\n@p99leaf = {{p99mid}}\n@p99mid = end\nGET {{p99url}}\n`, 'p99-chain');
    assert.ok((t ?? '').includes('/echo/p99-chain/end'), (t ?? 'no response').slice(0, 300));
  });
});
