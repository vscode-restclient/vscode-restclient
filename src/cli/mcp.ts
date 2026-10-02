/**
 * `restclient mcp [--root carpeta]`: servidor MCP por stdio, sin dependencias.
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
import { requestSummaries } from '../core/sequence';
import { execute, Options } from './index';

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

export function serveMcp(root: string, entrada: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): void {
    const absoluteRoot = path.resolve(root);
    const rl = readline.createInterface({ input: entrada, crlfDelay: Infinity });
    const responder = (id: Peticion['id'], body: { result?: unknown; error?: { code: number; message: string } }) => {
        output.write(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, ...body }) + '\n');
    };

    rl.on('line', async line => {
        if (line.trim() === '') {
            return;
        }
        let msg: Peticion;
        try {
            msg = JSON.parse(line);
        } catch {
            responder(null, { error: { code: -32700, message: 'Parse error' } });
            return;
        }
        const esNotificacion = msg.id === undefined;
        try {
            const result = await handle(msg, absoluteRoot);
            if (!esNotificacion) {
                responder(msg.id, { result: result });
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

async function handle(msg: Peticion, root: string): Promise<unknown> {
    switch (msg.method) {
        case 'initialize':
            return { protocolVersion: PROTOCOLO, capabilities: { tools: {} }, serverInfo: { name: 'restclient', version: version() } };
        case 'ping':
            return {};
        case 'tools/list':
            return { tools: HERRAMIENTAS };
        case 'tools/call':
            return llamar(msg.params ?? {}, root);
        default:
            if (msg.method?.startsWith('notifications/')) {
                return undefined;
            }
            throw new ErrorRpc(-32601, `Method not found: ${msg.method}`);
    }
}

/** El resultado de una herramienta va como texto; un error de uso va con isError, no como error de protocolo. */
async function llamar(params: Record<string, unknown>, root: string): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    const name = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const text = (t: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
    if (!HERRAMIENTAS.some(h => h.name === name)) {
        throw new ErrorRpc(-32602, `Unknown tool: ${name}`);
    }
    try {
        const file = insideRoot(String(args.file ?? ''), root);
        switch (name) {
            case 'list_requests':
                return text({ file: path.relative(root, file), requests: requestSummaries(fs.readFileSync(file, 'utf8')) });
            case 'send_request':
            case 'run_http_file': {
                if (name === 'send_request' && typeof args.name !== 'string') {
                    throw new Error('send_request needs the request name');
                }
                const options: Options = {
                    file,
                    variables: aTexto(args.vars),
                    secrets: aTexto(args.secrets),
                    environment: typeof args.env === 'string' ? args.env : undefined,
                    continueOnFailure: args.continueOnFailure === true,
                    json: true,
                    timeoutMs: typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 30_000,
                    solo: name === 'send_request' ? String(args.name) : undefined,
                };
                let json = '';
                const exitCode = await execute(options, l => { json += l; });
                const data = JSON.parse(json);
                return text({ ok: exitCode === 0, ...data }, exitCode !== 0);
            }
            default:
                throw new ErrorRpc(-32602, `Unknown tool: ${name}`);
        }
    } catch (e) {
        if (e instanceof ErrorRpc) {
            throw e;
        }
        return text(e instanceof Error ? e.message : String(e), true);
    }
}

/** Una ruta fuera de la raíz se rechaza: el agente sólo ve el proyecto que le han abierto. */
export function insideRoot(file: string, root: string): string {
    if (!file) {
        throw new Error('file is required');
    }
    const abs = path.resolve(root, file);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`${file} is outside the allowed root (${root})`);
    }
    if (!fs.existsSync(abs)) {
        throw new Error(`${file} does not exist`);
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
