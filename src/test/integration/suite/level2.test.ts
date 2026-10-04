import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const PUERTO = process.env.RC_TEST_PUERTO!;
const BASE = `http://[::1]:${PUERTO}`;
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BR = String.fromCharCode(10);
const j = (...l: string[]) => l.join(BR);

const setSetting = (key: string, value: unknown) =>
  vscode.workspace.getConfiguration('rest-client').update(key, value, vscode.ConfigurationTarget.Global);

/** Carpeta del espacio de trabajo de la prueba: ahí van los ficheros de verdad. */
function folder(): string {
  const c = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(c, 'la prueba necesita un espacio de trabajo abierto');
  return c!;
}

function write(name: string, contenido: string): string {
  const filePath = path.join(folder(), name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contenido);
  return filePath;
}

/**
 * Abre un fichero .http de disco, pone el cursor en la línea pedida, envía y
 * espera la respuesta que lleve la marca. La extensión reutiliza el documento
 * de respuesta, así que se busca la marca y no «un documento nuevo».
 */
async function sendFile(filePath: string, line: number, mark: string, segundos = 20): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  await vscode.commands.executeCommand('rest-client.request');

  for (let i = 0; i < segundos * 4; i++) {
    await esperar(250);
    const response = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() !== doc.uri.toString() && d.getText().includes(mark),
    );
    if (response) return response.getText();
  }
  const abiertos = vscode.workspace.textDocuments.map((d) => `${d.languageId}:${d.getText().slice(0, 60)}`).join(' | ');
  throw new Error(`sin respuesta con "${mark}" en ${segundos} s. Documentos: ${abiertos}`);
}

describe('Rest Client · formato JetBrains y secretos', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    assert.ok(ext, 'la extensión no está cargada');
    await ext!.activate();
    await setSetting('previewResponseInUntitledDocument', true);
    await setSetting('previewResponsePanelTakeFocus', false);
  });

  after(async () => {
    // Sin entorno ni secretos: que las demás suites no hereden nada.
    await vscode.commands.executeCommand('rest-client.switch-environment', '');
    await vscode.commands.executeCommand('rest-client.delete-secret', 'API_KEY');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('P-36 · http-client.env.json junto al fichero: el entorno elegido resuelve, y el privado manda', async () => {
    write('http-client.env.json', JSON.stringify({ dev: { host: BASE, path: '/public' }, prod: { host: 'http://unused' } }));
    write('http-client.private.env.json', JSON.stringify({ dev: { path: '/private-wins' } }));
    const file = write('entorno.http', j('GET {{host}}{{path}}', ''));

    await vscode.commands.executeCommand('rest-client.switch-environment', 'dev');
    const t = await sendFile(file, 0, '/private-wins');
    assert.ok(t.includes('HTTP/1.1 200'), `sin 200 en:\n${t.slice(0, 200)}`);
    assert.ok(/"path":\s*"\/private-wins"/.test(t), 'el privado debe mandar sobre el público');
  });

  it('P-37 · import + run #nombre: se envía la petición importada y su respuesta resuelve en el fichero que importa', async () => {
    write(path.join('lib', 'auth.http'), j(`@host = ${BASE}`, '', '# @name login', 'GET {{host}}/echo/login', ''));
    const file = write('api.http', j(
      'import ./lib/auth.http',
      '',
      'run #login',
      '',
      '###',
      '',
      'GET {{host}}/echo/facturas?desde={{login.response.body.$.path}}',
      '',
    ));

    const primera = await sendFile(file, 2, '"path": "/echo/login"');
    assert.ok(primera.includes('HTTP/1.1 200'), 'run #login debe enviar la petición importada');

    const segunda = await sendFile(file, 6, '/echo/facturas?desde=');
    assert.ok(/"path":\s*"\/echo\/facturas\?desde=\/echo\/login"/.test(segunda), 'la variable de petición del importado debe resolver: ' + segunda.slice(0, 200));
  });

  it('P-38 · $secret: guardado con el comando, se sustituye; el fichero no lo contiene', async () => {
    await vscode.commands.executeCommand('rest-client.set-secret', 'API_KEY', 'clave-secreta-123');
    const file = write('secreto.http', j(`GET ${BASE}/con-secreto`, 'X-Test: {{$secret API_KEY}}', ''));
    assert.ok(!fs.readFileSync(file, 'utf8').includes('clave-secreta-123'), 'el valor no está en el fichero');
    const t = await sendFile(file, 0, '/con-secreto');
    assert.ok(/"header":\s*"clave-secreta-123"/.test(t), 'el secreto debe llegar en la cabecera: ' + t.slice(0, 200));
  });

  it('P-39 · alias de JetBrains: $uuid, $isoTimestamp y $random.integer(min,max)', async () => {
    const file = write('alias.http', j(`GET ${BASE}/alias?u={{$uuid}}&t={{$isoTimestamp}}&r={{$random.integer(5,6)}}`, ''));
    const t = await sendFile(file, 0, '/alias?u=');
    const filePath = /"path":\s*"([^"]+)"/.exec(t)?.[1] ?? '';
    assert.ok(/u=[0-9a-f-]{36}&/.test(filePath), `sin uuid en ${filePath}`);
    assert.ok(/t=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(filePath), `sin fecha ISO en ${filePath}`);
    assert.ok(/r=5$/.test(filePath), `random.integer(5,6) solo puede dar 5: ${filePath}`);
  });
});

describe('Rest Client · streaming', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    await ext!.activate();
    await setSetting('previewResponseInUntitledDocument', true);
    await setSetting('previewResponsePanelTakeFocus', false);
  });

  after(async () => {
    await setSetting('previewResponseInUntitledDocument', true);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('P-42 · text/event-stream: el panel se abre en streaming antes de que termine, y al final llegan los 3 eventos', async () => {
    // Primero en modo panel: tiene que aparecer una pestaña «streaming» ANTES
    // del último evento (el servidor los espacia 200 ms).
    await setSetting('previewResponseInUntitledDocument', false);
    await esperar(300);
    const doc = await vscode.workspace.openTextDocument({ language: 'http', content: `GET ${BASE}/sse${BR}` });
    await vscode.window.showTextDocument(doc, { preview: false });
    // El comando no resuelve hasta que la petición TERMINA: hay que sondear
    // mientras está en vuelo, no después.
    const envio = vscode.commands.executeCommand('rest-client.request');
    let vistoStreaming = false;
    let vistoFinal = false;
    const vistas = new Set<string>();
    try {
      for (let i = 0; i < 100 && !vistoFinal; i++) {
        await esperar(50);
        const etiquetas = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);
        etiquetas.forEach((l) => vistas.add(l));
        if (etiquetas.some((l) => /streaming/.test(l))) vistoStreaming = true;
        if (vistoStreaming && etiquetas.some((l) => /^Response\(\d+ms\)$/.test(l))) vistoFinal = true;
      }
      assert.ok(vistoStreaming, 'el panel debe abrirse en modo streaming con el primer evento; pestañas vistas: ' + [...vistas].join(' | '));
      assert.ok(vistoFinal, 'al terminar el stream el panel pasa a la respuesta completa; pestañas vistas: ' + [...vistas].join(' | '));
    } finally {
      await envio;
      await setSetting('previewResponseInUntitledDocument', true);
    }

    // Y en modo documento, el cuerpo final trae los tres eventos.
    const file = write('sse.http', j(`GET ${BASE}/sse`, ''));
    const t = await sendFile(file, 0, '[DONE]');
    assert.ok(t.includes('content-type: text/event-stream'), 'la cabecera del stream');
    assert.ok(t.includes('data: {"delta":"Hola"}') && t.includes('data: {"delta":" mundo"}'), 'los tres eventos llegan enteros');
  });

  it('P-43 · WEBSOCKET: saludo del servidor, eco de dos mensajes y estado 101', async () => {
    const file = write('socket.http', j(
      '# @timeout 800',
      `WEBSOCKET ws://[::1]:${PUERTO}/socket`,
      'X-Test: ana',
      '',
      '{"a":1}',
      '===',
      'segundo',
      '',
    ));
    const t = await sendFile(file, 1, 'eco: segundo');
    assert.ok(t.includes('HTTP/1.1 101'), `sin 101 en ${t.slice(0, 120)}`);
    assert.ok(t.includes('<< hola ana'), 'el saludo del servidor lleva la cabecera enviada');
    assert.ok(t.includes('>> {"a":1}') && t.includes('<< eco: {"a":1}'), 'el primer mensaje y su eco');
    assert.ok(t.includes('-- closed after 800 ms'), 'se cierra al cumplirse @timeout: ' + t.slice(-80));
  });
});

describe('Rest Client · herramientas para agentes', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    await ext!.activate();
    await setSetting('previewResponseInUntitledDocument', true);
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('P-44 · las herramientas de modelo de lenguaje listan las peticiones y envían una por su nombre', async function () {
    const lm = (vscode as unknown as { lm?: { invokeTool?: Function } }).lm;
    if (!lm?.invokeTool) {
      this.skip();
      return;
    }
    const file = write('agente.http', j('# @name saludo', `GET ${BASE}/echo/agente`, 'X-Test: desde-agente', '', '###', '', `GET ${BASE}/otra`, ''));
    assert.ok(fs.existsSync(file));
    const token = new vscode.CancellationTokenSource().token;
    const text = (r: { content: { value?: string }[] }) => r.content.map((p) => p.value ?? '').join('');

    const lista = await lm.invokeTool('rest_client_list_requests', { input: { file: 'agente.http' }, toolInvocationToken: undefined }, token);
    const data = JSON.parse(text(lista));
    assert.strictEqual(data.requests.length, 2, JSON.stringify(data));
    assert.strictEqual(data.requests[0].name, 'saludo');
    assert.strictEqual(data.requests[0].method, 'GET');
    assert.strictEqual(data.requests[1].name, undefined);

    const envio = await lm.invokeTool('rest_client_send_request', { input: { file: 'agente.http', name: 'saludo' }, toolInvocationToken: undefined }, token);
    const r = JSON.parse(text(envio));
    assert.strictEqual(r.status, 200, JSON.stringify(r).slice(0, 200));
    assert.ok(r.body.includes('desde-agente'), 'la cabecera llegó al servidor: ' + r.body.slice(0, 120));
    assert.ok(typeof r.ms === 'number');

    await assert.rejects(
      () => lm!.invokeTool!('rest_client_list_requests', { input: { file: '../fuera.http' }, toolInvocationToken: undefined }, token),
      /outside the workspace/,
    );
  });
});

describe('RestClient · lo portado de rest-client-next', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    await ext!.activate();
    await setSetting('previewResponseInUntitledDocument', true);
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('P-47 · Basic Auth: la contraseña puede llevar dos puntos y espacios (upstream #1419)', async () => {
    // «admin:it's a total eclipse»: antes se partía por cada espacio y por cada
    // ':', y llegaba truncada.
    const key = "it's a total: eclipse";
    const file = write('basic.http', j(`GET ${BASE}/echo/basic`, `Authorization: Basic admin:${key}`, ''));
    const t = await sendFile(file, 0, '/echo/basic');
    const recibida = /"authorization":\s*"Basic ([^"]+)"/.exec(t)?.[1] ?? '';
    assert.ok(recibida, 'no llegó cabecera Authorization: ' + t.slice(0, 200));
    assert.strictEqual(Buffer.from(recibida, 'base64').toString('utf8'), `admin:${key}`);
  });

  it('P-48 · Basic Auth: la forma «usuario contraseña» separada por espacio sigue funcionando', async () => {
    const file = write('basic2.http', j(`GET ${BASE}/echo/basic2`, 'Authorization: Basic ana secreta', ''));
    const t = await sendFile(file, 0, '/echo/basic2');
    const recibida = /"authorization":\s*"Basic ([^"]+)"/.exec(t)?.[1] ?? '';
    assert.strictEqual(Buffer.from(recibida, 'base64').toString('utf8'), 'ana:secreta');
  });

  it('P-49 · autocompletar dentro de {{ }} no duplica las llaves', async () => {
    const file = write('completar.http', j('@host = http://ejemplo', 'GET {{host}}/x?id={{', ''));
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, { preview: false });
    const line = 1;
    const posicion = new vscode.Position(line, doc.lineAt(line).text.length);
    const lista = (await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider', doc.uri, posicion)) as vscode.CompletionList;

    const variables = lista.items.filter((i) => typeof i.label === 'string' && (i.label === '$guid' || i.label === 'host'));
    assert.ok(variables.length >= 1, 'sin propuestas de variable: ' + lista.items.map((i) => i.label).slice(0, 10).join(', '));
    for (const item of variables) {
      const text = typeof item.insertText === 'string' ? item.insertText : (item.insertText as vscode.SnippetString)?.value ?? '';
      assert.ok(!text.includes('{{'), `«${String(item.label)}» insertaría llaves otra vez: ${text}`);
      assert.ok(item.range, `«${String(item.label)}» no sustituye el hueco entre llaves`);
    }
  });
});

describe('metodo QUERY (portado de upstream #1438)', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    await ext!.activate();
    await setSetting('previewResponseInUntitledDocument', true);
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('P-66 · QUERY llega como QUERY y con su cuerpo', async function () {
    this.timeout(60000);
    const file = write('query.http', j(
      `QUERY ${BASE}/buscar`,
      'Content-Type: application/json',
      '',
      '{"filtro":"activo"}',
      '',
    ));
    const t = await sendFile(file, 0, '"/buscar"', 40);
    assert.ok(t.includes('HTTP/1.1 200'), `sin 200 en:\n${t.slice(0, 200)}`);
    assert.ok(/"method":\s*"QUERY"/.test(t), 'el servidor debe recibir el metodo QUERY: ' + t.slice(0, 250));
    assert.ok(/"received":\s*"\{\\"filtro\\":\\"activo\\"\}"/.test(t) || t.includes('filtro'), 'el cuerpo debe viajar con la peticion: ' + t.slice(0, 250));
  });
});

describe('faker en el editor (carga diferida)', () => {
  it('P-64 · {{$faker internet.email}} se resuelve al enviar (el chunk se carga en caliente)', async function () {
    this.timeout(60000);
    const file = write('faker.http', j(
      `GET ${BASE}/echo?email={{$faker internet.email}}`,
      'X-Test: faker-mark',
    ));
    const text = await sendFile(file, 0, 'faker-mark', 40);
    const email = /email=([^&"\\]+)/.exec(text)?.[1] ?? '';
    assert.ok(/%40|@/.test(email), `no parece un email: ${email || text.slice(0, 200)}`);
    assert.ok(!email.includes('faker'), 'la variable quedo sin resolver');
  });
});
