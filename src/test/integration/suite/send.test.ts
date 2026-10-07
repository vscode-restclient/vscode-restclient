import * as assert from 'assert';
import * as vscode from 'vscode';

const PORT = process.env.RC_TEST_PORT!;
const BASE = `http://[::1]:${PORT}`;
/** The same server by name: this is what exercises the resolution of localhost. */
const BASE_LOCALHOST = `http://localhost:${PORT}`;
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BR = String.fromCharCode(10);

/**
 * Opens a .http in the editor, runs Send Request and returns the response.
 *
 * The extension REUSES the response document between requests, so looking for
 * "a new document" is no good: it waits for the mark unique to this very
 * request to show up.
 */
async function send(httpText: string, mark: string, seconds = 20): Promise<string> {
  const doc = await vscode.workspace.openTextDocument({ language: 'http', content: httpText });
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand('rest-client.request');

  for (let i = 0; i < seconds * 4; i++) {
    await esperar(250);
    const response = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() !== doc.uri.toString() && d.getText().includes(mark),
    );
    if (response) return response.getText();
  }
  const openDocs = vscode.workspace.textDocuments.map((d) => `${d.languageId}:${d.getText().slice(0, 50)}`).join(' | ');
  throw new Error(`no response with "${mark}" in ${seconds} s. Documents: ${openDocs}`);
}

const setSetting = (key: string, value: unknown) =>
  vscode.workspace.getConfiguration('rest-client').update(key, value, vscode.ConfigurationTarget.Global);

describe('Rest Client · real requests', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    assert.ok(ext, 'the extension is not loaded');
    await ext!.activate();
    await setSetting('previewResponseInUntitledDocument', true);
    // These tests cover the default path, where the response takes the focus.
    // Another suite running before leaves it false globally, so here it goes
    // back to the default instead of inheriting theirs.
    await setSetting('previewResponsePanelTakeFocus', undefined);
  });

  describe('the basics', () => {
    it('P-01 · GET simple', async () => {
      const t = await send(`GET ${BASE}/hola\n`, '/hola');
      assert.ok(t.includes('HTTP/1.1 200'), `no 200 in:\n${t.slice(0, 200)}`);
      assert.ok(/"path":\s*"\/hola"/.test(t), 'the server did not see the path');
    });

    it('P-02 · POST with headers and body', async () => {
      const t = await send(
        `POST ${BASE}/crear\nContent-Type: application/json\nX-Test: valor-de-prueba\n\n{"a":1}\n`,
        'valor-de-prueba',
      );
      assert.ok(/"method":\s*"POST"/.test(t), 'did not arrive as POST');
      assert.ok(t.includes('valor-de-prueba'), 'the header did not arrive');
      assert.ok(t.includes('{\\"a\\":1}') || t.includes('"a":1'), 'the body did not arrive');
    });

    it('P-03 · file variables', async () => {
      const t = await send(`@ruta = /desde-variable\nGET ${BASE}{{ruta}}\n`, '/desde-variable');
      assert.ok(t.includes('/desde-variable'), 'the variable was not substituted');
    });

    it('P-08 · several requests separated by ###, the one under the cursor is sent', async () => {
      const t = await send(`GET ${BASE}/primera\n\n###\n\nGET ${BASE}/segunda\n`, '/primera');
      assert.ok(t.includes('/primera'), 'the request under the cursor must be the one sent');
      assert.ok(!t.includes('/segunda'), 'it must not send both');
    });
  });

  describe('responses other than 200', () => {
    // The marks carry the whole path on purpose: a bare "404" or "500" matches
    // the duration or the size of an earlier response (the panel is reused),
    // and the test ends up with the wrong document.
    it('P-05 · a 404 is shown, not swallowed', async () => {
      const t = await send(`GET ${BASE}/status/404\n`, '/status/404');
      assert.ok(t.includes('HTTP/1.1 404'), `no 404 in:\n${t.slice(0, 200)}`);
    });

    it('P-05 · a 500 is shown with its body', async () => {
      const t = await send(`GET ${BASE}/status/500\n`, '/status/500');
      assert.ok(t.includes('HTTP/1.1 500'), `no 500 in:\n${t.slice(0, 200)}`);
      assert.ok(t.includes('oops'), 'the error body must be visible');
    });
  });

  describe('redirects and timing', () => {
    it('P-06 · follows a redirect to its destination', async () => {
      const t = await send(`GET ${BASE}/redirige\n`, '/destino');
      assert.ok(t.includes('HTTP/1.1 200'));
      assert.ok(t.includes('/destino'), 'did not reach the destination of the redirect');
    });

    it('P-07 · a slow response arrives in the end', async () => {
      const t = await send(`GET ${BASE}/slow\n`, '/slow', 25);
      assert.ok(t.includes('HTTP/1.1 200'));
    });
  });

  describe('response formats', () => {
    it('P-09 · JSON is formatted to be readable', async () => {
      const t = await send(`GET ${BASE}/json\n`, 'nested');
      assert.ok(/\n\s+"nested"/.test(t), 'the JSON should come out indented');
    });

    it('P-09 · plain text is shown as it is', async () => {
      const t = await send(`GET ${BASE}/text\n`, 'plain text here');
      assert.ok(t.includes('plain text here'));
    });

    it('P-09 · XML is shown', async () => {
      const t = await send(`GET ${BASE}/xml\n`, '<root>');
      assert.ok(t.includes('<child>'), 'the XML should be visible');
    });
  });

  describe('re-sending requests', () => {
    // PR #1432 (fixes issue #682): preparing the request modified the headers
    // of the original object, so a re-send went out with the headers already
    // mangled. Now a copy is used.
    it('P-28 · re-sending a request does not carry mangled headers', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'http',
        content: `POST ${BASE}/reenvio` + BR + 'Content-Type: application/json' + BR + 'X-Test: original' + BR + BR + '{"n":1}' + BR
      });
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand('rest-client.request');
      await esperar(1500);
      // The same request is sent again: it must arrive identical.
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand('rest-client.rerun-last-request');

      let text = '';
      for (let i = 0; i < 60 && !text.includes('original'); i++) {
        await esperar(250);
        text = vscode.workspace.textDocuments
          .filter(d => d.uri.toString() !== doc.uri.toString())
          .map(d => d.getText()).find(t => t.includes('/reenvio')) ?? '';
      }
      assert.ok(text.includes('original'), `the re-send lost the header:` + BR + text.slice(0, 250));
      assert.ok(text.includes('HTTP/1.1 200'));
    });
  });

  describe('compatibility', () => {
    it('P-10 · a setting of our own is applied', async () => {
      await setSetting('defaultHeaders', { 'User-Agent': 'rest-client-propio' });
      try {
        const t = await send(`GET ${BASE}/cabeceras` + BR, 'rest-client-propio');
        assert.ok(t.includes('rest-client-propio'), 'the default header was not applied');
      } finally {
        await setSetting('defaultHeaders', undefined);
      }
    });

    it('P-16 · our own setting beats the inherited one', async () => {
      await setSetting('defaultHeaders', { 'User-Agent': 'el-nuevo' });
      try {
        const t = await send(`GET ${BASE}/cabeceras` + BR, 'el-nuevo');
        assert.ok(t.includes('el-nuevo'), 'our own setting must win');
        assert.ok(!t.includes('viene-de-restclient'), 'the inherited one must not slip in');
      } finally {
        await setSetting('defaultHeaders', undefined);
      }
    });
  });
});

describe('Rest Client · resolving localhost', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    await ext!.activate();
    await setSetting('previewResponseInUntitledDocument', true);
  });

  // PR #1396: the test server listens on IPv6 ONLY. Without the patch,
  // `localhost` resolved to 127.0.0.1 and the request never arrived.
  it('P-27 · localhost reaches a server that only listens on IPv6', async () => {
    const t = await send(`GET ${BASE_LOCALHOST}/por-nombre` + BR, '/por-nombre');
    assert.ok(t.includes('HTTP/1.1 200'), `did not get through by localhost:
${t.slice(0, 200)}`);
  });
});

describe('Rest Client · preview', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    await ext!.activate();
  });

  after(async () => {
    await setSetting('previewResponseInUntitledDocument', true);
  });

  // PR #1440: in Cursor `window.activeTextEditor.viewColumn` can be
  // undefined and the response was not shown. This is the path that failed.
  it('P-26 · shows the response in the panel, not only in a document', async () => {
    await setSetting('previewResponseInUntitledDocument', false);
    const doc = await vscode.workspace.openTextDocument({ language: 'http', content: `GET ${BASE}/panel` + BR });
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('rest-client.request');

    // The response panel is a webview: what is checked is that a new tab shows
    // up without the command having thrown.
    let present = false;
    for (let i = 0; i < 60 && !present; i++) {
      await esperar(250);
      present = vscode.window.tabGroups.all.some(g =>
        g.tabs.some(t => t.input instanceof vscode.TabInputWebview || /Response/i.test(t.label)));
    }
    assert.ok(present, 'the response panel did not show up');
  });
});

describe('Rest Client · request variables', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    await ext!.activate();
    await setSetting('previewResponseInUntitledDocument', true);
    // If the response took the focus, the next request would run against the
    // response document instead of the .http.
    await setSetting('previewResponsePanelTakeFocus', false);
  });

  /**
   * Runs two requests from the SAME file: the second uses data from the first.
   * Request variables are file-scoped, so the two have to coexist; what changes
   * between them is where the cursor is.
   */
  async function encadenar(httpText: string, mark: string): Promise<string> {
    const doc = await vscode.workspace.openTextDocument({ language: 'http', content: httpText });
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const lines = doc.getText().split(String.fromCharCode(10));
    const lineaDe = (needle: string) => {
      const i = lines.findIndex((l) => l.includes(needle));
      if (i < 0) throw new Error(`cannot find the line with "${needle}"`);
      return i;
    };

    // First request: the cursor on its URL line.
    const first = lineaDe('@name');
    editor.selection = new vscode.Selection(first + 1, 0, first + 1, 0);
    await vscode.commands.executeCommand('rest-client.request');

    // Wait for the SPECIFIC response of this first request: the response
    // document is reused and there could be a 200 left by an earlier test.
    // The server marks each response with `x-path`, so wait for the one of
    // THIS request and not for a 200 an earlier test left behind.
    const filePath = '/' + lines[first + 1].split('/').pop()!;
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      await esperar(250);
      ready = vscode.workspace.textDocuments.some(
        (d) => d.uri.toString() !== doc.uri.toString() && d.getText().includes('HTTP/1.1 200') && d.getText().includes('x-path: ' + filePath),
      );
    }
    assert.ok(ready, 'the first request never got a response');

    // Second: focus goes back to the .http and the cursor onto its line. Keep
    // the editor that showTextDocument RETURNS: the one from above may have
    // stopped being the active one, and `rest-client.request` acts on the
    // active one. With few documents open they coincided; with many, not.
    const editor2 = await vscode.window.showTextDocument(doc, { preview: false });
    const second = lineaDe('{{');
    editor2.selection = new vscode.Selection(second, 0, second, 0);
    await vscode.commands.executeCommand('rest-client.request');

    for (let i = 0; i < 80; i++) {
      await esperar(250);
      const r = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() !== doc.uri.toString() && d.getText().includes(mark),
      );
      if (r) return r.getText();
    }
    const openDocs = vscode.workspace.textDocuments
      .filter((d) => d.uri.toString() !== doc.uri.toString())
      .map((d) => d.getText().replace(/\s+/g, ' ').slice(0, 200))
      .join('  ||  ');
    throw new Error(`no response with "${mark}". What there is: ${openDocs}`);
  }

  it('P-12 · JSONPath extracts a value from the previous response', async () => {
    const t = await encadenar(
      `# @name primera\nGET ${BASE}/json\n\n###\n\n# segunda\nGET ${BASE}/echo-json?v={{primera.response.body.$.nested.a}}\n`,
      '/echo-json',
    );
    assert.ok(t.includes('/echo-json?v=1'), `the JSONPath did not resolve:\n${t.slice(0, 250)}`);
  });

  it('P-13 · XPath extracts a value from an XML response', async () => {
    const t = await encadenar(
      `# @name uno\nGET ${BASE}/xml\n\n###\n\n# segunda\nGET ${BASE}/echo-xml?v={{uno.response.body.//child/text()}}\n`,
      '/echo-xml',
    );
    assert.ok(t.includes('/echo-xml?v=value'), `the XPath did not resolve:\n${t.slice(0, 250)}`);
  });

  // PR #853: a JSONPath matching several values returned only the first, in
  // silence, which is worse than returning nothing: it looks like it works.
  it('P-29 · a JSONPath with several results returns all of them', async () => {
    const t = await encadenar(
      `# @name uno` + BR + `GET ${BASE}/list` + BR + BR + '###' + BR + BR + `GET ${BASE}/echo-lista?v={{uno.response.body.$.items[*].id}}` + BR,
      '/echo-lista',
    );
    assert.ok(t.includes('7') && t.includes('9'), `both identifiers should be there:` + BR + t.slice(0, 250));
  });

  it('P-14 · a header of the previous response can be read', async () => {
    const t = await encadenar(
      `# @name uno\nGET ${BASE}/json\n\n###\n\n# segunda\nGET ${BASE}/echo-cab?v={{uno.response.headers.content-type}}\n`,
      '/echo-cab',
    );
    assert.ok(t.includes('application/json'), `the header did not resolve:\n${t.slice(0, 250)}`);
  });
});
