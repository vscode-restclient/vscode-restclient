/**
 * restclient — el mismo fichero .http, ejecutado desde la terminal.
 *
 *   restclient peticiones.http [--env dev] [--var host=https://api] [--secret KEY=valor]
 *                              [--continuar] [--json] [--timeout ms]
 *
 * Es la petición número seis más votada del proyecto original (+44 votos desde
 * 2019) y lo que convierte un fichero de peticiones en una prueba de
 * integración: sale con código 1 si alguna aserción falla, que es lo único que
 * un servidor de integración continua necesita entender.
 */
import * as crypto from 'crypto';
import { faker } from '@faker-js/faker/locale/en';
import { fakerRegex, resolveFakerPath } from '../utils/fakerShared';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { terminalEnvironment } from '../core/environment';
import { environmentsFolder, readEnvironments } from '../core/jetBrainsEnvironments';
import { closeImports, Imported, resolveRun, variablesWithImports } from '../core/imports';
import { parseRequests } from './minimalParser';
import { Block, runSequence, isRequest, splitBlocks } from '../core/sequence';
import { checkAssertions, readAssertions, AssertionResult } from '../core/assertions';
import { isEventStream } from '../core/sse';
import { talk, bodyMessages, DEFAULT_LISTEN_MS } from '../core/websocket';
import { aJunit } from '../core/junit';

export interface Options {
    file: string;
    variables: Record<string, string>;
    secrets: Record<string, string>;
    environment?: string;
    continuar: boolean;
    json: boolean;
    timeoutMs: number;
    /** Sólo la petición con este nombre (lo usa el servidor MCP). */
    solo?: string;
    /** Ruta del informe JUnit XML, si se pide. */
    junit?: string;
}

export const USAGE = 'uso: restclient <fichero.http> [--env nombre] [--var clave=valor] [--secret NOMBRE=valor] [--continuar] [--json] [--junit informe.xml] [--timeout ms]';

export function readArguments(argv: string[]): Options | string {
    const variables: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    let file = '';
    let environment: string | undefined;
    let continuar = false;
    let json = false;
    let junit: string | undefined;
    let timeoutMs = 30_000;

    const parClaveValor = (par: string, que: string): [string, string] | string => {
        const corte = par.indexOf('=');
        if (corte < 1) {
            return `${que} mal escrito: "${par}". Se espera clave=valor`;
        }
        return [par.slice(0, corte), par.slice(corte + 1)];
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--var' || a === '-v') {
            const r = parClaveValor(argv[++i] ?? '', 'variable');
            if (typeof r === 'string') {
                return r.replace('variable mal escrito', 'variable mal escrita');
            }
            variables[r[0]] = r[1];
        } else if (a === '--secret' || a === '-s') {
            const r = parClaveValor(argv[++i] ?? '', 'secreto');
            if (typeof r === 'string') {
                return r;
            }
            secrets[r[0]] = r[1];
        } else if (a === '--env' || a === '-e') {
            environment = argv[++i];
            if (!environment) {
                return '--env necesita el nombre de un entorno de http-client.env.json';
            }
        } else if (a === '--timeout') {
            timeoutMs = Number(argv[++i]);
            if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                return '--timeout necesita un número de milisegundos mayor que 0';
            }
        } else if (a === '--continuar') {
            continuar = true;
        } else if (a === '--json') {
            json = true;
        } else if (a === '--junit') {
            junit = argv[++i];
            if (!junit) {
                return '--junit necesita la ruta del informe XML';
            }
        } else if (!a.startsWith('-')) {
            file = a;
        }
    }
    if (!file) {
        return USAGE;
    }
    return { file, variables, secrets, environment, continuar, json, timeoutMs, junit };
}

/** El bloque con `@name` = nombre, ya sea en el fichero o vía `run #nombre`. */
function soloElBloque(blocks: Block[], name: string): Block[] {
    const directo = blocks.find(b => b.name === name);
    if (directo) {
        return [directo];
    }
    return [{ text: `run #${name}`, line: 0 }];
}

/**
 * Variables de fichero: `@nombre = valor`, declaradas normalmente al principio
 * y válidas para todo el fichero. Se leen del texto completo, no del bloque,
 * porque así es como funcionan en el editor.
 */
export function fileVariables(text: string): Record<string, string> {
    const fuera: Record<string, string> = {};
    for (const m of text.matchAll(/^\s*@([A-Za-z_][\w.-]*)\s*=\s*(.*)$/gm)) {
        fuera[m[1]] = m[2].trim();
    }
    return fuera;
}

/** Secretos: de la línea de órdenes, o de `RESTCLIENT_SECRET_NOMBRE`. Faltar es un error, no un hueco. */
export function secret(name: string, secrets: Record<string, string>): string {
    const value = secrets[name] ?? process.env[`RESTCLIENT_SECRET_${name}`];
    if (value === undefined) {
        throw new Error(`falta el secreto "${name}": pásalo con --secret ${name}=valor o en la variable de entorno RESTCLIENT_SECRET_${name}`);
    }
    return value;
}

/**
 * Sustituye `{{variable}}` con lo dado en la línea de órdenes, el entorno y
 * las variables de sistema que tienen sentido fuera del editor. Las mismas
 * que en el editor, con los alias de JetBrains, para que un fichero se
 * comporte igual en los dos sitios.
 */
export function substitute(text: string, variables: Record<string, string>, secrets: Record<string, string> = {}): string {
    return text.replace(/\{\{([^{}]+)\}\}/g, (completo, name: string) => {
        const key = name.trim();
        if (key in variables) {
            return variables[key];
        }
        const [sistema, ...resto] = key.split(/\s+/);
        const argumento = resto.join(' ');
        switch (sistema.replace(/\(.*$/, '')) {
            case '$processEnv': return process.env[argumento] ?? '';
            case '$faker': {
                const grupos = fakerRegex.exec(key);
                if (!grupos) {
                    return completo;
                }
                const r = resolveFakerPath(faker, grupos[1], grupos[2]);
                return 'value' in r ? r.value : completo;
            }
            case '$secret': return secret(argumento, secrets);
            case '$guid':
            case '$uuid': return crypto.randomUUID();
            case '$timestamp': return String(Math.floor(Date.now() / 1000));
            case '$isoTimestamp': return new Date().toISOString();
            case '$datetime': return argumento.startsWith('rfc1123') ? new Date().toUTCString() : new Date().toISOString();
            case '$randomInt': {
                const [min, max] = argumento.split(/\s+/).map(Number);
                return Number.isFinite(min) && Number.isFinite(max) && min < max ? String(min + Math.floor(Math.random() * (max - min))) : completo;
            }
            case '$random.integer': {
                const m = /\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/.exec(key);
                if (!m) {
                    return completo;
                }
                const [min, max] = [Number(m[1]), Number(m[2])];
                return min < max ? String(min + Math.floor(Math.random() * (max - min))) : completo;
            }
            default: return completo;
        }
    });
}

export async function execute(options: Options, output: (line: string) => void): Promise<number> {
    const ficheroAbs = path.resolve(options.file);
    const text = fs.readFileSync(ficheroAbs, 'utf8');
    const root = path.dirname(ficheroAbs);
    const environment = terminalEnvironment(root, ficheroAbs);

    const { imported, faltan } = closeImports(ficheroAbs, text);
    for (const f of faltan) {
        environment.warn(`import: no existe ${f}`);
    }

    // Prioridad de menor a mayor: entorno de fichero -> @variables (importadas,
    // luego propias) -> --var. Lo de la línea de órdenes manda: es lo que
    // permite apuntar el mismo fichero a otro sitio desde el servidor de CI.
    const variables = {
        ...variablesDeEntorno(root, options.environment, environment.warn),
        ...variablesWithImports(text, imported),
        ...options.variables
    };

    const todos = splitBlocks(text).filter(isRequest);
    const blocks = options.solo ? soloElBloque(todos, options.solo) : todos;
    const porBloque = new Map<number, AssertionResult[]>();
    // Lo que ya han devuelto las peticiones con nombre, para poder encadenar.
    const previous = new Map<string, { body: string; headers: Record<string, string | undefined>; status: number }>();

    const steps = await runSequence(blocks, {
        continueOnFailure: options.continuar,
        resolver: async (b: Block) => {
            const real = resolveRun(b, text, imported);
            return { ...real, text: substitute(resolvePrevious(real.text, previous), variables, options.secrets) };
        },
        enviar: async (b: Block) => {
            const request = parseRequests(b.text, root, t => substitute(t, variables, options.secrets));
            const timeout = blockTimeout(b.text);
            const result = request.method === 'WEBSOCKET'
                ? await enviarWebSocket(request, timeout ?? DEFAULT_LISTEN_MS)
                : await sendRequest(request, timeout ?? options.timeoutMs);
            if (b.name) {
                previous.set(b.name, result);
            }
            return result;
        },
    });

    let failures = 0;
    steps.forEach((step, i) => {
        const results = step.error
            ? []
            : checkAssertions(readAssertions(blocks[i].text), { status: step.status, body: step.body, headers: step.headers, ms: step.ms });
        porBloque.set(i, results);
        const failed = results.filter(r => !r.passed);
        failures += failed.length + (step.error ? 1 : 0);

        if (!options.json) {
            const mark = step.error ? 'ERROR' : failed.length ? 'FALLA' : '  ok ';
            output(`${mark}  ${step.name.padEnd(20)} ${String(step.status ?? '').padStart(3)}  ${step.ms} ms`);
            for (const m of failed) {
                output(`         ${m.assertion.raw}   ->  ${truncate(m.actual)}`);
            }
            if (step.error) {
                output(`         ${step.error}`);
            }
        }
    });

    if (options.junit) {
        fs.writeFileSync(options.junit, aJunit(path.basename(options.file), steps.map((p, i) => ({
            name: p.name,
            ms: p.ms,
            error: p.error,
            failures: (porBloque.get(i) ?? []).filter(r => !r.passed).map(r => `${r.assertion.raw} -> ${r.actual}`)
        }))));
    }

    if (options.json) {
        output(JSON.stringify({
            file: options.file,
            steps: steps.map((p, i) => ({
                name: p.name, status: p.status, ms: p.ms, error: p.error,
                assertions: (porBloque.get(i) ?? []).map(r => ({ assertion: r.assertion.raw, passed: r.passed, actual: r.actual }))
            }))
        }, null, 2));
    } else {
        const total = steps.length;
        output('');
        output(failures === 0 ? `${total} peticiones, todo en verde` : `${total} peticiones, ${failures} fallo(s)`);
    }
    return failures === 0 ? 0 : 1;
}

/** Variables del entorno pedido, leídas de los http-client.env.json desde la carpeta del fichero hacia arriba. */
function variablesDeEntorno(root: string, name: string | undefined, warn: (m: string) => void): Record<string, string> {
    if (!name) {
        return {};
    }
    const folder = environmentsFolder(root);
    if (!folder) {
        warn(`--env ${name}: no hay http-client.env.json desde ${root} hacia arriba`);
        return {};
    }
    const environments = readEnvironments(folder, warn);
    if (!(name in environments)) {
        warn(`--env ${name}: ese entorno no está en ${folder}. Hay: ${Object.keys(environments).join(', ') || 'ninguno'}`);
        return {};
    }
    return environments[name];
}

/** `# @timeout 5000` en el bloque manda sobre el --timeout general. */
export function blockTimeout(text: string): number | undefined {
    const m = /^\s*(?:#|\/\/)\s*@timeout\s+(\d+)\s*$/m.exec(text);
    return m ? Number(m[1]) : undefined;
}

/** WebSocket: la «respuesta» es la transcripción, con estado 101 como en el editor. */
async function enviarWebSocket(p: { url: string; headers: Record<string, string>; body?: string | Buffer }, ms: number):
    Promise<{ status: number; body: string; headers: Record<string, string | undefined> }> {
    const body = typeof p.body === 'string' ? p.body : p.body?.toString('utf8');
    const r = await talk(p.url, p.headers, bodyMessages(body), ms);
    if (r.cerradoPor === 'error' && r.recibidos.length === 0) {
        throw new Error(r.detalle ?? 'WebSocket error');
    }
    return { status: 101, body: r.transcript, headers: { 'content-type': 'text/plain', 'x-closed-by': r.cerradoPor } };
}

/** Envía la petición con el cliente HTTP de Node: sin dependencias. */
function sendRequest(p: { method: string; url: string; headers: Record<string, string>; body?: string | Buffer }, timeoutMs: number):
    Promise<{ status: number; body: string; headers: Record<string, string | undefined> }> {
    return new Promise((resolver, rechazar) => {
        let destino: URL;
        try {
            destino = new URL(p.url);
        } catch {
            rechazar(new Error(`URL no válida: ${p.url}`));
            return;
        }
        const transporte = destino.protocol === 'https:' ? https : http;
        const request = transporte.request(destino, { method: p.method, headers: p.headers, timeout: timeoutMs }, response => {
            const chunks: Buffer[] = [];
            const terminar = () => resolver({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
                headers: response.headers as Record<string, string | undefined>
            });
            response.on('data', t => chunks.push(t as Buffer));
            response.on('end', terminar);
            // Un stream de eventos puede no terminar nunca: pasado el tiempo se
            // corta y lo recibido hasta entonces es la respuesta, no un error.
            if (isEventStream(response.headers['content-type'])) {
                const corte = setTimeout(() => { response.destroy(); terminar(); }, timeoutMs);
                response.on('end', () => clearTimeout(corte));
            }
        });
        request.on('timeout', () => request.destroy(new Error(`sin respuesta en ${timeoutMs} ms`)));
        request.on('error', e => rechazar(e));
        if (p.body !== undefined) {
            if (!Object.keys(p.headers).some(k => k.toLowerCase() === 'content-length')) {
                request.setHeader('Content-Length', Buffer.byteLength(p.body));
            }
            request.write(p.body);
        }
        request.end();
    });
}

/** Resuelve `{{nombre.response.body.$.x}}` con lo que ya respondió esa petición. */
function resolvePrevious(text: string, previous: Map<string, { body: string; headers: Record<string, string | undefined>; status: number }>): string {
    return text.replace(/\{\{(\w+)\.response\.(body|headers)\.([^{}]+)\}\}/g, (completo, name: string, parte: string, resto: string) => {
        const r = previous.get(name);
        if (!r) {
            return completo;
        }
        const subject = parte === 'headers' ? `headers.${resto.trim()}` : `body.${resto.trim()}`;
        // Se reutiliza el mismo resolutor que las aserciones: un solo lenguaje.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { valueFor } = require('../core/assertions');
        const value = valueFor(subject, { status: r.status, body: r.body, headers: r.headers, ms: 0 });
        return value === '' ? completo : value;
    });
}

const truncate = (s: string) => (s.length > 90 ? s.slice(0, 87) + '...' : s);

export { Imported };

if (require.main === module) {
    if (process.argv[2] === 'mcp') {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { serveMcp } = require('./mcp');
        const i = process.argv.indexOf('--raiz');
        serveMcp(i > 0 ? process.argv[i + 1] : process.cwd());
    } else {
        const options = readArguments(process.argv.slice(2));
        if (typeof options === 'string') {
            process.stderr.write(options + '\n');
            process.exit(2);
        }
        execute(options, l => process.stdout.write(l + '\n'))
            .then(exitCode => process.exit(exitCode))
            .catch(e => {
                process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
                process.exit(2);
            });
    }
}
