import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { carpetaDeEntornos, leerEntornos, variablesDelEntorno } from '../../core/entornosJetBrains';
import { bloqueLlamado, cerrarImportaciones, resolverRun, rutasImportadas, variablesConImportados } from '../../core/importaciones';
import { trocear } from '../../core/secuencia';

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
        const avisos: string[] = [];
        const e = leerEntornos(dir, m => avisos.push(m));
        assert.strictEqual(e.dev.host, 'http://publico');
        assert.strictEqual(e.dev.token, 'secreto', 'el privado manda sobre el publico');
        assert.strictEqual(e.dev.puerto, '8080', 'un numero se usa como texto');
        assert.strictEqual(e.prod.host, 'http://prod');
        assert.strictEqual(avisos.length, 0);

        fs.writeFileSync(path.join(dir, 'http-client.private.env.json'), '{ roto');
        const e2 = leerEntornos(dir, m => avisos.push(m));
        assert.strictEqual(e2.dev.host, 'http://publico', 'lo publico sigue valiendo');
        assert.strictEqual(avisos.length, 1, 'se avisa una vez del fichero roto');
        assert.ok(avisos[0].startsWith('http-client.private.env.json:'));

        assert.deepStrictEqual(variablesDelEntorno(dir, 'no-existe'), {});
        assert.deepStrictEqual(variablesDelEntorno(undefined, 'dev'), {});
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('P-33 · carpetaDeEntornos sube hasta encontrarlo y respeta el tope', () => {
        const raiz = carpetaTemporal();
        const hondo = path.join(raiz, 'api', 'v2', 'facturas');
        fs.mkdirSync(hondo, { recursive: true });
        fs.writeFileSync(path.join(raiz, 'api', 'http-client.env.json'), '{}');
        assert.strictEqual(carpetaDeEntornos(hondo), path.join(raiz, 'api'));
        assert.strictEqual(carpetaDeEntornos(hondo, raiz), path.join(raiz, 'api'), 'con tope por encima se encuentra igual');
        assert.strictEqual(carpetaDeEntornos(hondo, path.join(raiz, 'api', 'v2')), undefined, 'el tope frena antes de llegar');
        assert.strictEqual(carpetaDeEntornos(path.join(raiz, 'otra-que-no-existe'), raiz), undefined);
        fs.rmSync(raiz, { recursive: true, force: true });
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
        const { importados, faltan } = cerrarImportaciones(a);
        assert.deepStrictEqual(importados.map(i => path.basename(i.fichero)), ['b.http', 'c.http'], 'orden de aparicion, sin repetir a.http ni b.http');
        assert.deepStrictEqual(faltan.map(f => path.basename(f)), ['no-existe.http']);
        assert.deepStrictEqual(rutasImportadas("import 'x y.http'", a), [path.join(dir, 'x y.http')], 'las comillas admiten espacios');

        const vars = variablesConImportados(j('@host = http://propio', 'GET {{host}}'), importados);
        assert.strictEqual(vars.host, 'http://propio', 'la propia manda sobre la importada');
        assert.strictEqual(vars.extra, '1', 'las de segundo nivel tambien llegan');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('P-35 · resolverRun encuentra en el propio fichero antes que en el importado, y falla claro si no existe', () => {
        const propio = j('# @name login', 'POST http://propio/login', '', '###', '', 'run #login', '', '###', '', 'run #facturas', '', '###', '', 'run #nadie');
        const importados = [{ fichero: 'lib.http', texto: j('# @name login', 'POST http://lib/login', '', '###', '', '# @name facturas', 'GET http://lib/facturas') }];
        const bloques = trocear(propio);
        assert.strictEqual(resolverRun(bloques[0], propio, importados).texto, bloques[0].texto, 'un bloque normal se devuelve tal cual');

        const login = resolverRun(bloques[1], propio, importados);
        assert.ok(login.texto.includes('http://propio/login'), 'el propio manda sobre el importado');
        assert.strictEqual(login.nombre, 'login');
        assert.strictEqual(login.linea, bloques[1].linea, 'conserva la linea del run');

        const facturas = resolverRun(bloques[2], propio, importados);
        assert.ok(facturas.texto.includes('http://lib/facturas'));
        assert.strictEqual((facturas as { fichero?: string }).fichero, 'lib.http');

        assert.throws(() => resolverRun(bloques[3], propio, importados), /run #nadie: no hay ninguna petición/);
        assert.strictEqual(bloqueLlamado('nadie', propio, importados), undefined);
    });
});

import { esEventStream, leerEventos } from '../../core/sse';
import { leerTranscripcion, mensajesDelCuerpo } from '../../core/websocket';
import { comprobar, leerAserciones, valorDe } from '../../core/aserciones';

describe('streaming', () => {
    it('P-40 · leerEventos: campos, varias lineas data, comentarios y evento sin blanco final', () => {
        const e = leerEventos(j(': latido', '', 'id: 1', 'event: token', 'data: {"a":1}', '', 'data: linea 1', 'data: linea 2', '', 'data:sin espacio', 'event: fin'));
        assert.strictEqual(e.length, 3);
        assert.deepStrictEqual(e[0], { evento: 'token', datos: '{"a":1}', id: '1' });
        assert.strictEqual(e[1].datos, 'linea 1' + BR + 'linea 2', 'varias data se unen con salto de linea');
        assert.strictEqual(e[2].datos, 'sin espacio');
        assert.strictEqual(e[2].evento, 'fin', 'el ultimo evento cuenta aunque no cierre con linea en blanco');
        assert.deepStrictEqual(leerEventos(''), []);
        assert.ok(esEventStream('text/event-stream; charset=utf-8'));
        assert.ok(!esEventStream('application/json'));
    });

    it('P-41 · aserciones sse.* y ws.*', () => {
        const sse = { estado: 200, cuerpo: j('data: uno', '', 'data: dos', '', 'data: [DONE]', ''), cabeceras: { 'content-type': 'text/event-stream' }, ms: 5 };
        assert.strictEqual(valorDe('sse.count', sse), '3');
        assert.strictEqual(valorDe('sse.first', sse), 'uno');
        assert.strictEqual(valorDe('sse.last', sse), '[DONE]');
        const [ok] = comprobar(leerAserciones('# @assert sse.count == 3'), sse);
        assert.strictEqual(ok.pasa, true);

        const ws = { estado: 101, cuerpo: j('<< hola ana', '>> {"a":1}', '<< eco: {"a":1}', '-- closed after 300 ms'), ms: 300 };
        assert.deepStrictEqual(leerTranscripcion(ws.cuerpo), { recibidos: ['hola ana', 'eco: {"a":1}'], enviados: ['{"a":1}'] });
        assert.strictEqual(valorDe('ws.count', ws), '2');
        assert.strictEqual(valorDe('ws.last', ws), 'eco: {"a":1}');
        const [mal] = comprobar(leerAserciones('# @assert ws.nada == 1'), ws);
        assert.strictEqual(mal.pasa, false, 'un sujeto ws que no existe se rechaza');
        assert.deepStrictEqual(mensajesDelCuerpo(j('{"a":1}', '===', '', 'segundo', '=== ', '')), ['{"a":1}', 'segundo']);
        assert.deepStrictEqual(mensajesDelCuerpo(undefined), []);
    });
});

import { aJunit } from '../../core/junit';
import { parsear, trocearArgumentos } from '../../cli/parserMinimo';

describe('runner en todas partes', () => {
    it('P-45 · JUnit: un caso por peticion, failure por asercion fallida, error por peticion caida, y XML escapado', () => {
        const xml = aJunit('api.http', [
            { nombre: 'login', ms: 120, fallos: [] },
            { nombre: 'facturas', ms: 30, fallos: ['body.$.total == 3 -> 2', 'header.x == "a" -> <b>'] },
            { nombre: '#3', ms: 5, fallos: [], error: 'ECONNREFUSED' },
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
        const p = parsear(j(
            'QUERY http://api/buscar',
            'Content-Type: application/json',
            '',
            '{"filtro": "activo"}',
        ), '.');
        assert.strictEqual(p.metodo, 'QUERY');
        assert.strictEqual(p.url, 'http://api/buscar');
        assert.strictEqual(p.cabeceras['Content-Type'], 'application/json');
        assert.strictEqual(String(p.cuerpo), '{"filtro": "activo"}');
    });

    it('P-46 · cURL pegado: metodo, cabeceras, datos, usuario y continuaciones', () => {
        const p = parsear(j(
            "curl -X POST 'http://api/x?a=1' \\",
            "  -H 'Content-Type: application/json' \\",
            '  -H "X-Prueba: con espacio" \\',
            "  -u ana:secreta \\",
            "  -d '{\"a\": 1}'",
        ), '.');
        assert.strictEqual(p.metodo, 'POST');
        assert.strictEqual(p.url, 'http://api/x?a=1');
        assert.strictEqual(p.cabeceras['Content-Type'], 'application/json');
        assert.strictEqual(p.cabeceras['X-Prueba'], 'con espacio');
        assert.strictEqual(p.cabeceras['Authorization'], 'Basic ' + Buffer.from('ana:secreta').toString('base64'));
        assert.strictEqual(p.cuerpo, '{"a": 1}');

        const sencillo = parsear('curl https://api/lista', '.');
        assert.deepStrictEqual([sencillo.metodo, sencillo.url, sencillo.cuerpo], ['GET', 'https://api/lista', undefined]);
        const conDatos = parsear('curl https://api/form -d a=1 -d b=2', '.');
        assert.deepStrictEqual([conDatos.metodo, conDatos.cuerpo, conDatos.cabeceras['Content-Type']], ['POST', 'a=1&b=2', 'application/x-www-form-urlencoded']);
        assert.deepStrictEqual(trocearArgumentos(`-H "a: b c" -d 'x y' z\\ `), ['-H', 'a: b c', '-d', 'x y', 'z\\']);
        assert.throws(() => parsear('curl -X GET', '.'), /no lleva URL/);
    });
});
