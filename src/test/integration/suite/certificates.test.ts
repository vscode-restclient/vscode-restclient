import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LocalServer, selfSignedCertificate, startHttpsServer } from '../../localServers';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const setting = (section: string, key: string, value: unknown) =>
  vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);

function folder(): string {
  const c = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(c, 'the test needs an open workspace');
  return c!;
}

function write(name: string, content: string): string {
  const filePath = path.join(folder(), name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Opens a .http file FROM DISK (an untitled document has no path, which is the case that failed), sends and waits for the mark. */
async function sendFile(filePath: string, mark: string, seconds = 20): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
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

// #44: a certificate path relative to the .http file was never found; only the
// workspace-relative form worked. These run the real extension against a TLS
// server that asks for a client certificate and reports who presented one.
describe('Rest Client · client certificates', () => {
  let secure: LocalServer;

  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    assert.ok(ext, 'the extension is not loaded');
    await ext!.activate();
    secure = await startHttpsServer({ requestCert: true });
    await setting('rest-client', 'previewResponseInUntitledDocument', true);
    await setting('rest-client', 'previewResponsePanelTakeFocus', false);
  });

  after(async () => {
    await setting('rest-client', 'certificates', undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await secure.close();
    // The files stay: the workspace of the run is a temporary folder, and on
    // Windows the editor still holds the .http open at this point.
  });

  it('P-91 · a certificate path relative to the .http file is found when the workspace root has no such file', async function () {
    this.timeout(40000);
    // The .http file and its certificate live in a subfolder; nothing of that name exists in the root.
    const client = selfSignedCertificate();
    write('mtls/sub/client.pem', client.cert);
    write('mtls/sub/client.key', client.key);
    assert.ok(!fs.existsSync(path.join(folder(), 'client.pem')), 'the root must not have the certificate');
    const host = `127.0.0.1:${secure.port}`;
    await setting('rest-client', 'certificates', { [host]: { cert: 'client.pem', key: 'client.key' } });
    const file = write('mtls/sub/mtls.http', `GET https://${host}/echo/file-relative\n`);

    const text = await sendFile(file, '/echo/file-relative');
    assert.ok(text.includes('"peer": "localhost"') || text.includes('"peer":"localhost"'), 'the client certificate next to the .http file was sent: ' + text.slice(0, 300));
  });

  it('P-92 · with no certificate anywhere the request still goes out, without one', async function () {
    this.timeout(40000);
    const host = `127.0.0.1:${secure.port}`;
    await setting('rest-client', 'certificates', { [host]: { cert: 'nowhere.pem', key: 'nowhere.key' } });
    const file = write('mtls/sub/none.http', `GET https://${host}/echo/no-cert\n`);

    const text = await sendFile(file, '/echo/no-cert');
    assert.ok(text.includes('"peer": null') || text.includes('"peer":null'), 'no certificate was sent: ' + text.slice(0, 300));
  });
});
