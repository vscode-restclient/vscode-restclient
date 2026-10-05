/**
 * `restclient mcp [--root folder]`: an MCP server over stdio, no dependencies.
 *
 * What an agent (Claude Code, Cursor, Copilot's agent mode) needs in order to
 * use `.http` files as a tool: list requests, send one, run a whole file with
 * its assertions. Everything it returns is what `--json` prints, so what the
 * agent sees is what a person would see in the terminal.
 *
 * Security: only files inside the root are read (the current directory unless
 * told otherwise). An agent does not read what is not its business. And this
 * server writes nothing to disk.
 *
 * Protocol: JSON-RPC 2.0, one message per line. Methods: initialize, ping,
 * tools/list, tools/call; notifications get no reply.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { requestSummaries } from '../core/sequence';
import { execute, Options } from './index';

const PROTOCOL = '2025-06-18';

interface Request {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: Record<string, unknown>;
}

const TOOLS = [
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

export function serveMcp(root: string, inputStream: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): void {
    const absoluteRoot = path.resolve(root);
    const rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity });
    const reply = (id: Request['id'], body: { result?: unknown; error?: { code: number; message: string } }) => {
        output.write(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, ...body }) + '\n');
    };

    rl.on('line', async line => {
        if (line.trim() === '') {
            return;
        }
        let msg: Request;
        try {
            msg = JSON.parse(line);
        } catch {
            reply(null, { error: { code: -32700, message: 'Parse error' } });
            return;
        }
        const isNotification = msg.id === undefined;
        try {
            const result = await handle(msg, absoluteRoot);
            if (!isNotification) {
                reply(msg.id, { result: result });
            }
        } catch (e) {
            if (!isNotification) {
                const err = e as { code?: number; message?: string };
                reply(msg.id, { error: { code: typeof err.code === 'number' ? err.code : -32603, message: err.message ?? String(e) } });
            }
        }
    });
}

class RpcError extends Error {
    public constructor(public code: number, message: string) {
        super(message);
    }
}

async function handle(msg: Request, root: string): Promise<unknown> {
    switch (msg.method) {
        case 'initialize':
            return { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'restclient', version: version() } };
        case 'ping':
            return {};
        case 'tools/list':
            return { tools: TOOLS };
        case 'tools/call':
            return callTool(msg.params ?? {}, root);
        default:
            if (msg.method?.startsWith('notifications/')) {
                return undefined;
            }
            throw new RpcError(-32601, `Method not found: ${msg.method}`);
    }
}

/** A tool's result goes back as text; a usage error goes with isError, not as a protocol error. */
async function callTool(params: Record<string, unknown>, root: string): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
    const name = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const text = (t: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
    if (!TOOLS.some(h => h.name === name)) {
        throw new RpcError(-32602, `Unknown tool: ${name}`);
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
                    variables: toText(args.vars),
                    secrets: toText(args.secrets),
                    environment: typeof args.env === 'string' ? args.env : undefined,
                    continueOnFailure: args.continueOnFailure === true,
                    json: true,
                    timeoutMs: typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 30_000,
                    only: name === 'send_request' ? String(args.name) : undefined,
                };
                let json = '';
                const exitCode = await execute(options, l => { json += l; });
                const data = JSON.parse(json);
                return text({ ok: exitCode === 0, ...data }, exitCode !== 0);
            }
            default:
                throw new RpcError(-32602, `Unknown tool: ${name}`);
        }
    } catch (e) {
        if (e instanceof RpcError) {
            throw e;
        }
        return text(e instanceof Error ? e.message : String(e), true);
    }
}

/** A path outside the root is refused: the agent only sees the project it was opened on. */
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

const toText = (o: unknown): Record<string, string> =>
    o && typeof o === 'object' ? Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {};

function version(): string {
    for (const candidate of [path.join(__dirname, '..', '..', 'package.json'), path.join(__dirname, '..', 'package.json')]) {
        try {
            return JSON.parse(fs.readFileSync(candidate, 'utf8')).version ?? '0.0.0';
        } catch { /* try the next one */ }
    }
    return '0.0.0';
}
