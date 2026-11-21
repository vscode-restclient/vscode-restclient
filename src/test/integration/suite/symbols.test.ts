import * as assert from 'assert';
import * as vscode from 'vscode';

// The outline (document symbols) names an unnamed request by its method and
// path. These pin what it shows for the three URL shapes a .http file can
// have, so that replacing url.parse() with the URL class changes nothing a
// user sees. url.parse() took `localhost:` for a protocol and showed
// "GET 3000/api"; that one is a fix, not a change. The host goes in the
// symbol's containerName, which the executeDocumentSymbolProvider command
// returns as '' for every symbol (the file-variable one included), so the
// host part is covered by the unit test of requestOutline instead.
describe('Rest Client · outline of a .http file', () => {
  async function symbolsOf(content: string): Promise<vscode.SymbolInformation[]> {
    const doc = await vscode.workspace.openTextDocument({ language: 'http', content });
    await vscode.window.showTextDocument(doc, { preview: false });
    for (let i = 0; i < 40; i++) {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeDocumentSymbolProvider', doc.uri);
      if (symbols && symbols.length > 0) {
        return symbols;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('no document symbols in 10 s');
  }

  it('P-95 · an absolute URL shows method and path with query', async function () {
    this.timeout(30000);
    const symbols = await symbolsOf('GET https://api.example.com:8443/items?page=2 HTTP/1.1\n');
    const request = symbols.find((s) => s.name.startsWith('GET '));
    assert.ok(request, JSON.stringify(symbols.map((s) => s.name)));
    assert.strictEqual(request!.name, 'GET /items?page=2');
  });

  it('P-95 · a bare path is shown as written', async function () {
    this.timeout(30000);
    const symbols = await symbolsOf('POST /api/items?x=1\nContent-Type: application/json\n\n{}\n');
    const request = symbols.find((s) => s.name.startsWith('POST '));
    assert.ok(request, JSON.stringify(symbols.map((s) => s.name)));
    assert.strictEqual(request!.name, 'POST /api/items?x=1');
  });

  it('P-95 · a host without a scheme is shown whole, not cut at the colon', async function () {
    this.timeout(30000);
    const symbols = await symbolsOf('GET localhost:3000/api/items\n');
    const request = symbols.find((s) => s.name.startsWith('GET '));
    assert.ok(request, JSON.stringify(symbols.map((s) => s.name)));
    assert.strictEqual(request!.name, 'GET localhost:3000/api/items');
  });
});
