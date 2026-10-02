import * as assert from 'assert';
import * as vscode from 'vscode';

const PUERTO = process.env.RC_TEST_PUERTO!;
const BASE = `http://[::1]:${PUERTO}`;
/** El mismo servidor por nombre: así se ejercita la resolución de localhost. */
const BASE_LOCALHOST = `http://localhost:${PUERTO}`;
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BR = String.fromCharCode(10);

/**
 * Abre un .http en el editor, ejecuta Send Request y devuelve la respuesta.
 *
 * La extensión REUTILIZA el documento de respuesta entre peticiones, así que no
 * vale buscar «un documento nuevo»: se espera a que aparezca la marca única de
 * esta petición concreta.
 */
async function enviar(contenido: string, mark: string, segundos = 20): Promise<string> {
  const doc = await vscode.workspace.openTextDocument({ language: 'http', content: contenido });
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand('rest-client.request');

  for (let i = 0; i < segundos * 4; i++) {
    await esperar(250);
    const response = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() !== doc.uri.toString() && d.getText().includes(mark),
    );
    if (response) return response.getText();
  }
  const abiertos = vscode.workspace.textDocuments.map((d) => `${d.languageId}:${d.getText().slice(0, 50)}`).join(' | ');
  throw new Error(`sin respuesta con "${mark}" en ${segundos} s. Documentos: ${abiertos}`);
}

const ajuste = (key: string, value: unknown) =>
  vscode.workspace.getConfiguration('rest-client').update(key, value, vscode.ConfigurationTarget.Global);

describe('Rest Client · peticiones reales', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    assert.ok(ext, 'la extensión no está cargada');
    await ext!.activate();
    await ajuste('previewResponseInUntitledDocument', true);
  });

  describe('lo básico', () => {
    it('P-01 · GET simple', async () => {
      const t = await enviar(`GET ${BASE}/hola\n`, '/hola');
      assert.ok(t.includes('HTTP/1.1 200'), `sin 200 en:\n${t.slice(0, 200)}`);
      assert.ok(/"path":\s*"\/hola"/.test(t), 'el servidor no vio la ruta');
    });

    it('P-02 · POST con cabeceras y cuerpo', async () => {
      const t = await enviar(
        `POST ${BASE}/crear\nContent-Type: application/json\nX-Test: valor-de-prueba\n\n{"a":1}\n`,
        'valor-de-prueba',
      );
      assert.ok(/"method":\s*"POST"/.test(t), 'no llegó como POST');
      assert.ok(t.includes('valor-de-prueba'), 'no llegó la cabecera');
      assert.ok(t.includes('{\\"a\\":1}') || t.includes('"a":1'), 'no llegó el cuerpo');
    });

    it('P-03 · variables de fichero', async () => {
      const t = await enviar(`@ruta = /desde-variable\nGET ${BASE}{{ruta}}\n`, '/desde-variable');
      assert.ok(t.includes('/desde-variable'), 'la variable no se sustituyó');
    });

    it('P-08 · varias peticiones separadas por ###, se envía la del cursor', async () => {
      const t = await enviar(`GET ${BASE}/primera\n\n###\n\nGET ${BASE}/segunda\n`, '/primera');
      assert.ok(t.includes('/primera'), 'debe enviarse la petición donde está el cursor');
      assert.ok(!t.includes('/segunda'), 'no debe enviar las dos');
    });
  });

  describe('respuestas que no son 200', () => {
    // Las marcas llevan la ruta entera a proposito: «404» o «500» a secas
    // casan con la duracion o el tamano de una respuesta anterior (el panel
    // se reutiliza), y el test se queda con el documento equivocado.
    it('P-05 · un 404 se muestra, no se traga', async () => {
      const t = await enviar(`GET ${BASE}/status/404\n`, '/status/404');
      assert.ok(t.includes('HTTP/1.1 404'), `sin 404 en:\n${t.slice(0, 200)}`);
    });

    it('P-05 · un 500 se muestra con su cuerpo', async () => {
      const t = await enviar(`GET ${BASE}/status/500\n`, '/status/500');
      assert.ok(t.includes('HTTP/1.1 500'), `sin 500 en:\n${t.slice(0, 200)}`);
      assert.ok(t.includes('oops'), 'debe verse el cuerpo del error');
    });
  });

  describe('redirecciones y tiempos', () => {
    it('P-06 · sigue una redirección hasta el destino', async () => {
      const t = await enviar(`GET ${BASE}/redirige\n`, '/destino');
      assert.ok(t.includes('HTTP/1.1 200'));
      assert.ok(t.includes('/destino'), 'no llegó al destino de la redirección');
    });

    it('P-07 · una respuesta lenta acaba llegando', async () => {
      const t = await enviar(`GET ${BASE}/slow\n`, '/slow', 25);
      assert.ok(t.includes('HTTP/1.1 200'));
    });
  });

  describe('formatos de respuesta', () => {
    it('P-09 · JSON se formatea legible', async () => {
      const t = await enviar(`GET ${BASE}/json\n`, 'nested');
      assert.ok(/\n\s+"nested"/.test(t), 'el JSON debería salir indentado');
    });

    it('P-09 · texto plano se muestra tal cual', async () => {
      const t = await enviar(`GET ${BASE}/text\n`, 'plain text here');
      assert.ok(t.includes('plain text here'));
    });

    it('P-09 · XML se muestra', async () => {
      const t = await enviar(`GET ${BASE}/xml\n`, '<root>');
      assert.ok(t.includes('<child>'), 'debería verse el XML');
    });
  });

  describe('reenvío de peticiones', () => {
    // PR #1432 (arregla el issue #682): al preparar la petición se modificaban
    // las cabeceras del objeto original, así que un reenvío salía con las
    // cabeceras ya manipuladas. Ahora se trabaja sobre una copia.
    it('P-28 · reenviar una petición no arrastra cabeceras manipuladas', async () => {
      const doc = await vscode.workspace.openTextDocument({
        language: 'http',
        content: `POST ${BASE}/reenvio` + BR + 'Content-Type: application/json' + BR + 'X-Test: original' + BR + BR + '{"n":1}' + BR
      });
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand('rest-client.request');
      await esperar(1500);
      // Se reenvía la misma petición: debe llegar idéntica.
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand('rest-client.rerun-last-request');

      let text = '';
      for (let i = 0; i < 60 && !text.includes('original'); i++) {
        await esperar(250);
        text = vscode.workspace.textDocuments
          .filter(d => d.uri.toString() !== doc.uri.toString())
          .map(d => d.getText()).find(t => t.includes('/reenvio')) ?? '';
      }
      assert.ok(text.includes('original'), `el reenvío perdió la cabecera:` + BR + text.slice(0, 250));
      assert.ok(text.includes('HTTP/1.1 200'));
    });
  });

  describe('compatibilidad', () => {
    it('P-10 · un ajuste propio se aplica', async () => {
      await ajuste('defaultHeaders', { 'User-Agent': 'rest-client-propio' });
      try {
        const t = await enviar(`GET ${BASE}/cabeceras` + BR, 'rest-client-propio');
        assert.ok(t.includes('rest-client-propio'), 'no se aplicó la cabecera por defecto');
      } finally {
        await ajuste('defaultHeaders', undefined);
      }
    });

    it('P-16 · el ajuste propio gana al heredado', async () => {
      await ajuste('defaultHeaders', { 'User-Agent': 'el-nuevo' });
      try {
        const t = await enviar(`GET ${BASE}/cabeceras` + BR, 'el-nuevo');
        assert.ok(t.includes('el-nuevo'), 'debe mandar el ajuste propio');
        assert.ok(!t.includes('viene-de-restclient'), 'el heredado no debe colarse');
      } finally {
        await ajuste('defaultHeaders', undefined);
      }
    });
  });
});

describe('Rest Client · resolución de localhost', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    await ext!.activate();
    await ajuste('previewResponseInUntitledDocument', true);
  });

  // PR #1396: el servidor de pruebas escucha SOLO en IPv6. Sin el parche,
  // `localhost` se resolvía a 127.0.0.1 y la petición no llegaba.
  it('P-27 · localhost alcanza un servidor que solo escucha en IPv6', async () => {
    const t = await enviar(`GET ${BASE_LOCALHOST}/por-nombre` + BR, '/por-nombre');
    assert.ok(t.includes('HTTP/1.1 200'), `no llegó por localhost:
${t.slice(0, 200)}`);
  });
});

describe('Rest Client · vista previa', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    await ext!.activate();
  });

  after(async () => {
    await ajuste('previewResponseInUntitledDocument', true);
  });

  // PR #1440: en Cursor `window.activeTextEditor.viewColumn` puede ser
  // undefined y la respuesta no se mostraba. Este es el camino que fallaba.
  it('P-26 · muestra la respuesta en el panel, no solo en un documento', async () => {
    await ajuste('previewResponseInUntitledDocument', false);
    const doc = await vscode.workspace.openTextDocument({ language: 'http', content: `GET ${BASE}/panel` + BR });
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('rest-client.request');

    // El panel de respuesta es un webview: se comprueba que aparece una pestaña
    // nueva sin que el comando haya lanzado.
    let hay = false;
    for (let i = 0; i < 60 && !hay; i++) {
      await esperar(250);
      hay = vscode.window.tabGroups.all.some(g =>
        g.tabs.some(t => t.input instanceof vscode.TabInputWebview || /Response/i.test(t.label)));
    }
    assert.ok(hay, 'no apareció el panel de respuesta');
  });
});

describe('Rest Client · variables de petición', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    await ext!.activate();
    await ajuste('previewResponseInUntitledDocument', true);
    // Si la respuesta se lleva el foco, la siguiente petición se ejecutaría
    // sobre el documento de respuesta y no sobre el .http.
    await ajuste('previewResponsePanelTakeFocus', false);
  });

  /**
   * Ejecuta dos peticiones del MISMO fichero: la segunda usa datos de la
   * primera. Las variables de petición son de ámbito de fichero, así que tienen
   * que convivir; lo que cambia entre una y otra es dónde está el cursor.
   */
  async function encadenar(contenido: string, mark: string): Promise<string> {
    const doc = await vscode.workspace.openTextDocument({ language: 'http', content: contenido });
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const lines = doc.getText().split(String.fromCharCode(10));
    const lineaDe = (aguja: string) => {
      const i = lines.findIndex((l) => l.includes(aguja));
      if (i < 0) throw new Error(`no encuentro la línea con "${aguja}"`);
      return i;
    };

    // Primera petición: el cursor sobre su línea de URL.
    const primera = lineaDe('@name');
    editor.selection = new vscode.Selection(primera + 1, 0, primera + 1, 0);
    await vscode.commands.executeCommand('rest-client.request');

    // Se espera a la respuesta CONCRETA de esta primera petición: el documento
    // de respuesta se reutiliza y podría haber un 200 de una prueba anterior.
    // El servidor marca cada respuesta con `x-path`, así que se espera a la de
    // ESTA petición y no a un 200 que dejó una prueba anterior.
    const filePath = '/' + lines[primera + 1].split('/').pop()!;
    let lista = false;
    for (let i = 0; i < 60 && !lista; i++) {
      await esperar(250);
      lista = vscode.workspace.textDocuments.some(
        (d) => d.uri.toString() !== doc.uri.toString() && d.getText().includes('HTTP/1.1 200') && d.getText().includes('x-path: ' + filePath),
      );
    }
    assert.ok(lista, 'la primera petición no llegó a responder');

    // Segunda: se recupera el foco del .http y se pone el cursor en su línea.
    // Hay que quedarse con el editor que DEVUELVE showTextDocument: el de
    // arriba pudo dejar de ser el activo, y `rest-client.request` actua sobre
    // el activo. Con pocos documentos abiertos coincidian; con muchos, no.
    const editor2 = await vscode.window.showTextDocument(doc, { preview: false });
    const segunda = lineaDe('{{');
    editor2.selection = new vscode.Selection(segunda, 0, segunda, 0);
    await vscode.commands.executeCommand('rest-client.request');

    for (let i = 0; i < 80; i++) {
      await esperar(250);
      const r = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() !== doc.uri.toString() && d.getText().includes(mark),
      );
      if (r) return r.getText();
    }
    const abiertos = vscode.workspace.textDocuments
      .filter((d) => d.uri.toString() !== doc.uri.toString())
      .map((d) => d.getText().replace(/\s+/g, ' ').slice(0, 200))
      .join('  ||  ');
    throw new Error(`sin respuesta con "${mark}". Lo que hay: ${abiertos}`);
  }

  it('P-12 · JSONPath extrae un valor de la respuesta anterior', async () => {
    const t = await encadenar(
      `# @name primera\nGET ${BASE}/json\n\n###\n\n# segunda\nGET ${BASE}/echo-json?v={{primera.response.body.$.nested.a}}\n`,
      '/echo-json',
    );
    assert.ok(t.includes('/echo-json?v=1'), `el JSONPath no se resolvió:\n${t.slice(0, 250)}`);
  });

  it('P-13 · XPath extrae un valor de una respuesta XML', async () => {
    const t = await encadenar(
      `# @name uno\nGET ${BASE}/xml\n\n###\n\n# segunda\nGET ${BASE}/echo-xml?v={{uno.response.body.//child/text()}}\n`,
      '/echo-xml',
    );
    assert.ok(t.includes('/echo-xml?v=value'), `el XPath no se resolvió:\n${t.slice(0, 250)}`);
  });

  // PR #853: un JSONPath que casa con varios valores devolvía solo el primero
  // en silencio, que es peor que no devolver nada: parece que funciona.
  it('P-29 · un JSONPath con varios resultados los devuelve todos', async () => {
    const t = await encadenar(
      `# @name uno` + BR + `GET ${BASE}/list` + BR + BR + '###' + BR + BR + `GET ${BASE}/echo-lista?v={{uno.response.body.$.items[*].id}}` + BR,
      '/echo-lista',
    );
    assert.ok(t.includes('7') && t.includes('9'), `deberían venir los dos identificadores:` + BR + t.slice(0, 250));
  });

  it('P-14 · se puede leer una cabecera de la respuesta anterior', async () => {
    const t = await encadenar(
      `# @name uno\nGET ${BASE}/json\n\n###\n\n# segunda\nGET ${BASE}/echo-cab?v={{uno.response.headers.content-type}}\n`,
      '/echo-cab',
    );
    assert.ok(t.includes('application/json'), `la cabecera no se resolvió:\n${t.slice(0, 250)}`);
  });
});
