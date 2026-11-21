import * as assert from 'assert';
import * as vscode from 'vscode';

const PORT = process.env.RC_TEST_PORT!;
const BASE = `http://[::1]:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens a .http, sends it and returns the response text, or `undefined` if none shows up in the time given. */
async function trySend(httpText: string, mark: string, seconds: number): Promise<string | undefined> {
  const doc = await vscode.workspace.openTextDocument({ language: 'http', content: httpText });
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand('rest-client.request');
  for (let i = 0; i < seconds * 4; i++) {
    await wait(250);
    const response = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() !== doc.uri.toString() && d.getText().includes(mark),
    );
    if (response) {
      return response.getText();
    }
  }
  return undefined;
}

// P-96: a `{{variable}}` nobody defined used to go on the wire as text. Now
// the editor refuses to send and names it; `# @allow-unresolved` keeps the old
// behaviour for a body that is meant to carry `{{…}}` (a template, say).
describe('Rest Client · unresolved variables', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    assert.ok(ext, 'the extension is not loaded');
    await ext!.activate();
    await vscode.workspace.getConfiguration('rest-client').update('previewResponseInUntitledDocument', true, vscode.ConfigurationTarget.Global);
  });

  it('P-96 · a request with an undefined variable is not sent', async function () {
    this.timeout(30000);
    // The mark is in the path the server echoes back; a response with it means the request went out.
    const t = await trySend(`GET ${BASE}/echo/p96-refused/{{nobodyDefinedThis}}\n`, 'p96-refused', 5);
    assert.strictEqual(t, undefined, `the request was sent:\n${(t ?? '').slice(0, 200)}`);
  });

  it('P-96 · with "# @allow-unresolved" the text goes as it is', async function () {
    this.timeout(30000);
    const t = await trySend(`# @allow-unresolved\nGET ${BASE}/echo/p96-allowed/{{nobodyDefinedThis}}\n`, 'p96-allowed', 20);
    assert.ok(t, 'no response');
    assert.ok(t!.includes('HTTP/1.1 200'), `no 200 in:\n${t!.slice(0, 200)}`);
    // The braces travel percent-encoded; the server echoes the path it got.
    assert.ok(/\{\{nobodyDefinedThis\}\}|%7B%7BnobodyDefinedThis%7D%7D/.test(t!), 'the server did not see the literal {{…}}');
  });
});
