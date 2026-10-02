import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { environmentsFolder, readEnvironments, environmentVariables } from '../../core/jetBrainsEnvironments';
import { namedBlock, closeImports, resolveRun, importedPaths, variablesWithImports } from '../../core/imports';
import { splitBlocks } from '../../core/sequence';

const BR = String.fromCharCode(10);
const j = (...l: string[]) => l.join(BR);

function carpetaTemporal(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'hk-nivel2-'));
}

describe('ficheros de entorno de JetBrains', () => {
    it('P-32 · publico + privado: el privado manda; un JSON roto avisa y no tumba', () => {
        const dir = carpetaTemporal();
        fs.writeFileSync(path.join(dir, 'http-client.env.json'), JSON.stringify({ dev: { host: 'http://publico', token: 'x' }, prod: { host: 'http://prod' } }));
        fs.writeFileSync(path.join(dir, 'http-client.private.env.json'), JSON.stringify({ dev: { token: 'secreto', puerto: 8080 } }));
        const warnings: string[] = [];
        const e = readEnvironments(dir, m => warnings.push(m));
        assert.strictEqual(e.dev.host, 'http://publico');
        assert.strictEqual(e.dev.token, 'secreto', 'el privado manda sobre el publico');
        assert.strictEqual(e.dev.puerto, '8080', 'un numero se usa como texto');
        assert.strictEqual(e.prod.host, 'http://prod');
        assert.strictEqual(warnings.length, 0);

        fs.writeFileSync(path.join(dir, 'http-client.private.env.json'), '{ roto');
        const e2 = readEnvironments(dir, m => warnings.push(m));
        assert.strictEqual(e2.dev.host, 'http://publico', 'lo publico sigue valiendo');
        assert.strictEqual(warnings.length, 1, 'se avisa una vez del fichero roto');
        assert.ok(warnings[0].startsWith('http-client.private.env.json:'));

        assert.deepStrictEqual(environmentVariables(dir, 'no-existe'), {});
        assert.deepStrictEqual(environmentVariables(undefined, 'dev'), {});
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('P-33 · carpetaDeEntornos sube hasta encontrarlo y respeta el tope', () => {
        const root = carpetaTemporal();
        const hondo = path.join(root, 'api', 'v2', 'facturas');
        fs.mkdirSync(hondo, { recursive: true });
        fs.writeFileSync(path.join(root, 'api', 'http-client.env.json'), '{}');
        assert.strictEqual(environmentsFolder(hondo), path.join(root, 'api'));
        assert.strictEqual(environmentsFolder(hondo, root), path.join(root, 'api'), 'con tope por encima se encuentra igual');
        assert.strictEqual(environmentsFolder(hondo, path.join(root, 'api', 'v2')), undefined, 'el tope frena antes de llegar');
        assert.strictEqual(environmentsFolder(path.join(root, 'otra-que-no-existe'), root), undefined);
        fs.rmSync(root, { recursive: true, force: true });
    });
});

describe('import y run', () => {
    it('P-34 · cerrarImportaciones sigue cadenas, corta ciclos y lista lo que falta', () => {
        const dir = carpetaTemporal();
        const a = path.join(dir, 'a.http');
        const b = path.join(dir, 'lib', 'b.http');
        const c = path.join(dir, 'lib', 'c.http');
        fs.mkdirSync(path.dirname(b));
        fs.writeFileSync(a, j('import ./lib/b.http', 'import "./no-existe.http"', '', 'GET http://a'));
        fs.writeFileSync(b, j('@host = http://b', 'import ./c.http', '', '# @name login', 'POST {{host}}/login'));
        fs.writeFileSync(c, j('import ../a.http', 'import ./b.http', '@extra = 1'));
        const { imported, faltan } = closeImports(a);
        assert.deepStrictEqual(imported.map(i => path.basename(i.file)), ['b.http', 'c.http'], 'orden de aparicion, sin repetir a.http ni b.http');
        assert.deepStrictEqual(faltan.map(f => path.basename(f)), ['no-existe.http']);
        assert.deepStrictEqual(importedPaths("import 'x y.http'", a), [path.join(dir, 'x y.http')], 'las comillas admiten espacios');

        const vars = variablesWithImports(j('@host = http://propio', 'GET {{host}}'), imported);
        assert.strictEqual(vars.host, 'http://propio', 'la propia manda sobre la importada');
        assert.strictEqual(vars.extra, '1', 'las de segundo nivel tambien llegan');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('P-35 · resolverRun encuentra en el propio fichero antes que en el importado, y falla claro si no existe', () => {
        const propio = j('# @name login', 'POST http://propio/login', '', '###', '', 'run #login', '', '###', '', 'run #facturas', '', '###', '', 'run #nadie');
        const imported = [{ file: 'lib.http', text: j('# @name login', 'POST http://lib/login', '', '###', '', '# @name facturas', 'GET http://lib/facturas') }];
        const blocks = splitBlocks(propio);
        assert.strictEqual(resolveRun(blocks[0], propio, imported).text, blocks[0].text, 'un bloque normal se devuelve tal cual');

        const login = resolveRun(blocks[1], propio, imported);
        assert.ok(login.text.includes('http://propio/login'), 'el propio manda sobre el importado');
        assert.strictEqual(login.name, 'login');
        assert.strictEqual(login.line, blocks[1].line, 'conserva la linea del run');

        const facturas = resolveRun(blocks[2], propio, imported);
        assert.ok(facturas.text.includes('http://lib/facturas'));
        assert.strictEqual((facturas as { file?: string }).file, 'lib.http');

        assert.throws(() => resolveRun(blocks[3], propio, imported), /run #nadie: no hay ninguna petición/);
        assert.strictEqual(namedBlock('nadie', propio, imported), undefined);
    });
});

import { isEventStream, readEvents } from '../../core/sse';
import { readTranscript, bodyMessages } from '../../core/websocket';
import { checkAssertions, readAssertions, valueFor } from '../../core/assertions';

describe('streaming', () => {
    it('P-40 · leerEventos: campos, varias lineas data, comentarios y evento sin blanco final', () => {
        const e = readEvents(j(': latido', '', 'id: 1', 'event: token', 'data: {"a":1}', '', 'data: linea 1', 'data: linea 2', '', 'data:sin espacio', 'event: fin'));
        assert.strictEqual(e.length, 3);
        assert.deepStrictEqual(e[0], { event: 'token', data: '{"a":1}', id: '1' });
        assert.strictEqual(e[1].data, 'linea 1' + BR + 'linea 2', 'varias data se unen con salto de linea');
        assert.strictEqual(e[2].data, 'sin espacio');
        assert.strictEqual(e[2].event, 'fin', 'el ultimo evento cuenta aunque no cierre con linea en blanco');
        assert.deepStrictEqual(readEvents(''), []);
        assert.ok(isEventStream('text/event-stream; charset=utf-8'));
        assert.ok(!isEventStream('application/json'));
    });

    it('P-41 · aserciones sse.* y ws.*', () => {
        const sse = { status: 200, body: j('data: uno', '', 'data: dos', '', 'data: [DONE]', ''), headers: { 'content-type': 'text/event-stream' }, ms: 5 };
        assert.strictEqual(valueFor('sse.count', sse), '3');
        assert.strictEqual(valueFor('sse.first', sse), 'uno');
        assert.strictEqual(valueFor('sse.last', sse), '[DONE]');
        const [ok] = checkAssertions(readAssertions('# @assert sse.count == 3'), sse);
        assert.strictEqual(ok.passed, true);

        const ws = { status: 101, body: j('<< hola ana', '>> {"a":1}', '<< eco: {"a":1}', '-- closed after 300 ms'), ms: 300 };
        assert.deepStrictEqual(readTranscript(ws.body), { recibidos: ['hola ana', 'eco: {"a":1}'], enviados: ['{"a":1}'] });
        assert.strictEqual(valueFor('ws.count', ws), '2');
        assert.strictEqual(valueFor('ws.last', ws), 'eco: {"a":1}');
        const [mal] = checkAssertions(readAssertions('# @assert ws.nada == 1'), ws);
        assert.strictEqual(mal.passed, false, 'un sujeto ws que no existe se rechaza');
        assert.deepStrictEqual(bodyMessages(j('{"a":1}', '===', '', 'segundo', '=== ', '')), ['{"a":1}', 'segundo']);
        assert.deepStrictEqual(bodyMessages(undefined), []);
    });
});

import { aJunit } from '../../core/junit';
import { parseRequests, splitArguments } from '../../cli/minimalParser';

describe('runner en todas partes', () => {
    it('P-45 · JUnit: un caso por peticion, failure por asercion fallida, error por peticion caida, y XML escapado', () => {
        const xml = aJunit('api.http', [
            { name: 'login', ms: 120, failures: [] },
            { name: 'facturas', ms: 30, failures: ['body.$.total == 3 -> 2', 'header.x == "a" -> <b>'] },
            { name: '#3', ms: 5, failures: [], error: 'ECONNREFUSED' },
        ]);
        assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
        assert.ok(xml.includes('<testsuite name="api.http" tests="3" failures="1" errors="1" time="0.155">'));
        assert.ok(xml.includes('<testcase name="login" classname="api.http" time="0.120"/>'));
        assert.strictEqual((xml.match(/<failure /g) || []).length, 2, 'una failure por asercion');
        assert.ok(xml.includes('&lt;b&gt;') && xml.includes('&quot;a&quot;'), 'lo que rompe el XML va escapado');
        assert.ok(xml.includes('<error message="ECONNREFUSED"/>'));
        assert.ok(xml.trimEnd().endsWith('</testsuite>'));
    });

    it('P-65 · QUERY: el runner lo reconoce como metodo y conserva el cuerpo', () => {
        const p = parseRequests(j(
            'QUERY http://api/buscar',
            'Content-Type: application/json',
            '',
            '{"filtro": "activo"}',
        ), '.');
        assert.strictEqual(p.method, 'QUERY');
        assert.strictEqual(p.url, 'http://api/buscar');
        assert.strictEqual(p.headers['Content-Type'], 'application/json');
        assert.strictEqual(String(p.body), '{"filtro": "activo"}');
    });

    it('P-46 · cURL pegado: metodo, cabeceras, datos, usuario y continuaciones', () => {
        const p = parseRequests(j(
            "curl -X POST 'http://api/x?a=1' \\",
            "  -H 'Content-Type: application/json' \\",
            '  -H "X-Prueba: con espacio" \\',
            "  -u ana:secreta \\",
            "  -d '{\"a\": 1}'",
        ), '.');
        assert.strictEqual(p.method, 'POST');
        assert.strictEqual(p.url, 'http://api/x?a=1');
        assert.strictEqual(p.headers['Content-Type'], 'application/json');
        assert.strictEqual(p.headers['X-Prueba'], 'con espacio');
        assert.strictEqual(p.headers['Authorization'], 'Basic ' + Buffer.from('ana:secreta').toString('base64'));
        assert.strictEqual(p.body, '{"a": 1}');

        const sencillo = parseRequests('curl https://api/lista', '.');
        assert.deepStrictEqual([sencillo.method, sencillo.url, sencillo.body], ['GET', 'https://api/lista', undefined]);
        const conDatos = parseRequests('curl https://api/form -d a=1 -d b=2', '.');
        assert.deepStrictEqual([conDatos.method, conDatos.body, conDatos.headers['Content-Type']], ['POST', 'a=1&b=2', 'application/x-www-form-urlencoded']);
        assert.deepStrictEqual(splitArguments(`-H "a: b c" -d 'x y' z\\ `), ['-H', 'a: b c', '-d', 'x y', 'z\\']);
        assert.throws(() => parseRequests('curl -X GET', '.'), /no lleva URL/);
    });
});
