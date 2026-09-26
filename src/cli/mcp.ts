/**
 * `restclient mcp [--raiz carpeta]`: servidor MCP por stdio, sin dependencias.
 *
 * Lo que un agente (Claude Code, Cursor, el modo agente de Copilot) necesita
 * para usar los ficheros `.http` como herramienta: listar peticiones, enviar
 * una, ejecutar un fichero entero con sus aserciones. Todo lo que devuelve es
 * lo mismo que imprime `--json`, así que lo que ve el agente es lo que vería
 * una persona en la terminal.
 *
 * Seguridad: sólo se leen ficheros dentro de la raíz (el directorio actual si
 * no se indica otra). Un agente no lee lo que no le toca. Y este servidor no
 * escribe nada en disco.
 *
 * Protocolo: JSON-RPC 2.0, un mensaje por línea. Métodos: initialize, ping,
 * tools/list, tools/call; las notificaciones no se contestan.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { resumenDePeticiones } from '../core/secuencia';
import { ejecutar, Opciones } from './index';

const PROTOCOLO = '2025-06-18';

interface Peticion {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: Record<string, unknown>;
}

const HERRAMIENTAS = [
    {
        name: 'list_requests',
        description: 'List the requests (name, method, url, line) defined in a .http file. Nothing is sent.',
        inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Path to the .http file, relative to the root' } }, required: ['file'] },
    },
    {
        name: 'send_request',
        description: 'Send one request of a .http file (by its # @name) and return status, time, assertions and body. Variables come from http-client.env.json (env), --var style overrides (vars) and secrets.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string' },
                name: { type: 'string', description: 'The # @name of the request' },
                env: { type: 'string', description: 'Environment name from http-client.env.json' },
                vars: { type: 'object', additionalProperties: { type: 'string' } },
                secrets: { type: 'object', additionalProperties: { type: 'string' } },
                timeoutMs: { type: 'number' },
            },
            required: ['file', 'name'],
        },
    },
    {
        name: 'run_http_file',
        description: 'Run every request of a .http file in order, with its # @assert checks. Returns one entry per request with status, time, assertions and body.',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string' },
                env: { type: 'string' },
                vars: { type: 'object', additionalProperties: { type: 'string' } },
                secrets: { type: 'object', additionalProperties: { type: 'string' } },
                continueOnFailure: { type: 'boolean' },
                timeoutMs: { type: 'number' },
            },
            required: ['file'],
        },
    },
];

export function servirMcp(raiz: string, entrada: NodeJS.ReadableStream = process.stdin, salida: NodeJS.WritableStream = process.stdout): void {
    const raizAbs = path.resolve(raiz);
    const rl = readline.createInterface({ input: entrada, crlfDelay: Infinity });
    const responder = (id: Peticion['id'], cuerpo: { result?: unknown; error?: { code: number; message: string } }) => {
        salida.write(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, ...cuerpo }) + '\n');
    };

    rl.on('line', async linea => {
        if (linea.trim() === '') {
            return;
        }
        let msg: Peticion;
        try {
            msg = JSON.parse(linea);
        } catch {
            responder(null, { error: { code: -32700, message: 'Parse error' } });
            return;
        }
        const esNotificacion = msg.id === undefined;
        try {
            const resultado = await atender(msg, raizAbs);
            if (!esNotificacion) {
                responder(msg.id, { result: resultado });
            }
        } catch (e) {
            if (!esNotificacion) {
                const err = e as { code?: number; message?: string };
                responder(msg.id, { error: { code: typeof err.code === 'number' ? err.code : -32603, message: err.message ?? String(e) } });
            }
        }
    });
}

class ErrorRpc extends Error {
    public constructor(public code: number, message: string) {
        super(message);
    }
}

async function atender(msg: Peticion, raiz: string): Promise<unknown> {
    switch (msg.method) {
        case 'initialize':
            return { protocolVersion: PROTOCOLO, capabilities: { tools: {} }, serverInfo: { name: 'restclient', version: version() } };
        case 'ping':
            return {};
        case 'tools/list':
            return { tools: HERRAMIENTAS };
        case 'tools/call':
            return llamar(msg.params ?? {}, raiz);
        default:
            if (msg.method?.startsWith('notifications/')) {
                return undefined;
            }
            throw new ErrorRpc(-32601, `Method not found: ${msg.method}`);
    }
}

/** El resultado de una herramienta va como texto; un error de uso va con isError, no como error de protocolo. */
async function llamar(params: Record<string, unknown>, raiz: string): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    const nombre = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const texto = (t: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
    if (!HERRAMIENTAS.some(h => h.name === nombre)) {
        throw new ErrorRpc(-32602, `Unknown tool: ${nombre}`);
    }
    try {
        const fichero = dentroDeLaRaiz(String(args.file ?? ''), raiz);
        switch (nombre) {
            case 'list_requests':
                return texto({ file: path.relative(raiz, fichero), requests: resumenDePeticiones(fs.readFileSync(fichero, 'utf8')) });
            case 'send_request':
            case 'run_http_file': {
                if (nombre === 'send_request' && typeof args.name !== 'string') {
                    throw new Error('send_request needs the request name');
                }
                const opciones: Opciones = {
                    fichero,
                    variables: aTexto(args.vars),
                    secretos: aTexto(args.secrets),
                    entorno: typeof args.env === 'string' ? args.env : undefined,
                    continuar: args.continueOnFailure === true,
                    json: true,
                    timeoutMs: typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 30_000,
                    solo: nombre === 'send_request' ? String(args.name) : undefined,
                };
                let json = '';
                const codigo = await ejecutar(opciones, l => { json += l; });
                const datos = JSON.parse(json);
                return texto({ ok: codigo === 0, ...datos }, codigo !== 0);
            }
            default:
                throw new ErrorRpc(-32602, `Unknown tool: ${nombre}`);
        }
    } catch (e) {
        if (e instanceof ErrorRpc) {
            throw e;
        }
        return texto(e instanceof Error ? e.message : String(e), true);
    }
}

/** Una ruta fuera de la raíz se rechaza: el agente sólo ve el proyecto que le han abierto. */
export function dentroDeLaRaiz(fichero: string, raiz: string): string {
    if (!fichero) {
        throw new Error('file is required');
    }
    const abs = path.resolve(raiz, fichero);
    const rel = path.relative(raiz, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`${fichero} is outside the allowed root (${raiz})`);
    }
    if (!fs.existsSync(abs)) {
        throw new Error(`${fichero} does not exist`);
    }
    return abs;
}

const aTexto = (o: unknown): Record<string, string> =>
    o && typeof o === 'object' ? Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {};

function version(): string {
    for (const candidato of [path.join(__dirname, '..', '..', 'package.json'), path.join(__dirname, '..', 'package.json')]) {
        try {
            return JSON.parse(fs.readFileSync(candidato, 'utf8')).version ?? '0.0.0';
        } catch { /* siguiente */ }
    }
    return '0.0.0';
}
