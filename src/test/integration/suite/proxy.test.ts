import * as assert from 'assert';
import * as vscode from 'vscode';
import { LocalProxy, LocalServer, startHttpServer, startHttpsServer, startProxy } from '../../localServers';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const setting = (section: string, key: string, value: unknown) =>
  vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);

// #32: with `http.proxy` set, no https request got out. These run the real
// extension against a real forward proxy and a real TLS endpoint.
describe('Rest Client · proxy', () => {
  let proxy: LocalProxy;
  let plain: LocalServer;
  let secure: LocalServer;

  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    assert.ok(ext, 'the extension is not loaded');
    await ext!.activate();
    [proxy, plain, secure] = await Promise.all([startProxy(), startHttpServer(), startHttpsServer()]);
    await setting('rest-client', 'previewResponseInUntitledDocument', true);
    // VS Code has a proxy layer of its own, which by default decides the route
    // of every extension's requests and discards the agent they set. It is
    // switched off here so that what is tested is the agent this extension
    // sets, and back on for the last test.
    await setting('http', 'proxySupport', 'off');
    await setting('http', 'proxy', `http://127.0.0.1:${proxy.port}`);
  });

  after(async () => {
    // The other suites must not inherit a proxy.
    await setting('http', 'proxy', undefined);
    await setting('http', 'proxySupport', undefined);
    await setting('rest-client', 'excludeHostsForProxy', undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await Promise.all([proxy.close(), plain.close(), secure.close()]);
  });

  beforeEach(() => {
    proxy.seen.length = 0;
    proxy.credentials.length = 0;
  });

  it('P-74 · with http.proxy set, an http request goes through the proxy', async () => {
    const url = `http://127.0.0.1:${plain.port}/p74`;
    const t = await send(`GET ${url}\n`, '/p74');
    assert.ok(t.includes('HTTP/1.1 200'), `no 200 in:\n${t.slice(0, 300)}`);
    assert.ok(/^via: 1\.1 test-proxy$/im.test(t), `the response did not come through the proxy:\n${t.slice(0, 300)}`);
    assert.deepStrictEqual(proxy.seen, [`GET ${url}`]);
  });

  it('P-75 · with http.proxy set, an https request goes through the proxy and arrives', async () => {
    const t = await send(`GET https://127.0.0.1:${secure.port}/p75\n`, '/p75');
    assert.ok(/"scheme":\s*"https"/.test(t), `not answered by the https server:\n${t.slice(0, 300)}`);
    assert.deepStrictEqual(proxy.seen, [`CONNECT 127.0.0.1:${secure.port}`]);
  });

  it('P-76 · a host excluded from the proxy is reached directly, even after a proxied request', async () => {
    await setting('rest-client', 'excludeHostsForProxy', ['127.0.0.1']);
    try {
      const t = await send(`GET https://127.0.0.1:${secure.port}/p76\n`, '/p76');
      assert.ok(/"scheme":\s*"https"/.test(t), `not answered by the https server:\n${t.slice(0, 300)}`);
      assert.deepStrictEqual(proxy.seen, [], 'an excluded host must not go through the proxy');
    } finally {
      await setting('rest-client', 'excludeHostsForProxy', undefined);
    }
  });

  it('P-77 · with the proxy layer of VS Code in its default mode, the request still arrives', async () => {
    await setting('http', 'proxySupport', undefined);
    // Which route it takes is VS Code's decision in this mode (it does not
    // proxy loopback addresses); what matters is that the two layers together
    // do not break the request.
    const t = await send(`GET https://127.0.0.1:${secure.port}/p77\n`, '/p77');
    assert.ok(/"scheme":\s*"https"/.test(t), `not answered by the https server:\n${t.slice(0, 300)}`);
  });
});
