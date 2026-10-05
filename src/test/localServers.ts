/**
 * Servers for the proxy tests, all on 127.0.0.1 and all in-process: an HTTP
 * and an HTTPS endpoint that say which one answered, and a forward proxy that
 * remembers what it was asked for.
 */
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';

export interface LocalServer {
    port: number;
    close(): Promise<void>;
}

export interface LocalProxy extends LocalServer {
    /** One line per request the proxy handled: `GET http://host/path` or `CONNECT host:port`. */
    seen: string[];
    /** The `Proxy-Authorization` header of each of those requests, `''` when there was none. */
    credentials: string[];
    /** For a proxy reached over TLS: the server name each connection asked for, `''` when it sent none. */
    serverNames: string[];
}

const LOOPBACK = '127.0.0.1';

function listen<T extends net.Server>(server: T, host = LOOPBACK): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => resolve((server.address() as net.AddressInfo).port));
    });
}

function closer(server: http.Server | https.Server, sockets: Set<net.Socket>): () => Promise<void> {
    return () => new Promise((resolve) => {
        // Tunnels and keep-alive connections would keep the server open.
        sockets.forEach((s) => s.destroy());
        server.close(() => resolve());
    });
}

function track(server: net.Server): Set<net.Socket> {
    const sockets = new Set<net.Socket>();
    server.on('connection', (s: net.Socket) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
    });
    return sockets;
}

const answer = (scheme: string): http.RequestListener => (q, r) => {
    // `/redirect?to=<url>` sends the client somewhere else, another scheme included.
    const redirect = '/redirect?to=';
    if (q.url?.startsWith(redirect)) {
        r.writeHead(302, { location: decodeURIComponent(q.url.slice(redirect.length)) });
        r.end();
        return;
    }
    r.writeHead(200, { 'content-type': 'application/json', 'x-answered-by': scheme });
    r.end(JSON.stringify({ scheme, path: q.url, host: q.headers.host }));
};

export async function startHttpServer(): Promise<LocalServer> {
    const server = http.createServer(answer('http'));
    const sockets = track(server);
    return { port: await listen(server), close: closer(server, sockets) };
}

export async function startHttpsServer(): Promise<LocalServer> {
    const server = https.createServer(selfSignedCertificate(), answer('https'));
    const sockets = track(server);
    return { port: await listen(server), close: closer(server, sockets) };
}

/**
 * A forward proxy: plain requests arrive in absolute form and are replayed,
 * `CONNECT` opens a blind tunnel. It marks what it forwards with a `Via`
 * header, so a response that came through it can be told from one that did not.
 *
 * It only serves 127.0.0.1. Inside VS Code, `http.proxy` is also the proxy of
 * the editor itself, and its own traffic (telemetry, update checks) has no
 * business leaving through a test: it is refused and left out of `seen`.
 *
 * With `tls`, the proxy itself is reached over TLS (`https://localhost:port`),
 * with the same throwaway certificate as the https endpoint. It listens on
 * `localhost` so that there is a name to ask for.
 */
export async function startProxy(options: { tls?: boolean } = {}): Promise<LocalProxy> {
    const seen: string[] = [];
    const credentials: string[] = [];
    const serverNames: string[] = [];
    const handler: http.RequestListener = (q, r) => {
        let target: URL | undefined;
        try {
            target = new URL(q.url ?? '');
        } catch {
            // Not in absolute form: not a proxy request.
        }
        if (target?.hostname !== LOOPBACK) {
            r.writeHead(403);
            r.end('this proxy only serves the tests');
            return;
        }
        seen.push(`${q.method} ${q.url}`);
        credentials.push(q.headers['proxy-authorization'] ?? '');
        const upstream = http.request(
            { host: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: q.method, headers: q.headers },
            (answered) => {
                r.writeHead(answered.statusCode ?? 502, { ...answered.headers, via: '1.1 test-proxy' });
                answered.pipe(r);
            });
        upstream.on('error', () => {
            r.writeHead(502);
            r.end();
        });
        q.pipe(upstream);
    };
    const server = options.tls ? https.createServer(selfSignedCertificate(), handler) : http.createServer(handler);
    const sockets = track(server);
    server.on('secureConnection', (s: { servername?: string | false }) => serverNames.push(s.servername || ''));
    server.on('connect', (q: http.IncomingMessage, client: net.Socket, head: Buffer) => {
        const at = (q.url ?? '').lastIndexOf(':');
        if ((q.url ?? '').slice(0, at) !== LOOPBACK) {
            client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
        }
        seen.push(`CONNECT ${q.url}`);
        credentials.push(q.headers['proxy-authorization'] ?? '');
        const upstream = net.connect(Number((q.url ?? '').slice(at + 1)), LOOPBACK, () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
        });
        sockets.add(upstream);
        // Either end going away takes the other with it: a tunnel has no
        // reason to outlive one of its sides.
        upstream.on('close', () => {
            sockets.delete(upstream);
            client.destroy();
        });
        client.on('close', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
    });
    return { port: await listen(server, options.tls ? 'localhost' : LOOPBACK), seen, credentials, serverNames, close: closer(server, sockets) };
}

// --- A throwaway certificate, made here instead of kept in the repository ----

function der(tag: number, ...parts: Buffer[]): Buffer {
    const body = Buffer.concat(parts);
    const length = body.length < 0x80
        ? Buffer.from([body.length])
        : body.length < 0x100
            ? Buffer.from([0x81, body.length])
            : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
    return Buffer.concat([Buffer.from([tag]), length, body]);
}

const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (hex: string) => der(0x06, Buffer.from(hex, 'hex'));
const utcTime = (d: Date) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z', 'ascii'));
const pem = (label: string, body: Buffer) =>
    `-----BEGIN ${label}-----\n${(body.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;

/**
 * A self-signed certificate for `localhost` / 127.0.0.1, valid for a day,
 * with a key generated on the spot. Nothing trusts it, which is the point:
 * the tests run against clients that do not verify.
 */
export function selfSignedCertificate(): { key: string; cert: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const ecdsaWithSha256 = sequence(oid('2a8648ce3d040302'));
    const name = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('localhost', 'utf8')))));
    const serial = crypto.randomBytes(8);
    serial[0] = (serial[0] & 0x7f) | 0x01;
    const now = Date.now();
    const subjectAltName = sequence(
        oid('551d11'),
        der(0x04, sequence(der(0x82, Buffer.from('localhost', 'ascii')), der(0x87, Buffer.from([127, 0, 0, 1])))));
    const toBeSigned = sequence(
        der(0xa0, der(0x02, Buffer.from([2]))),
        der(0x02, serial),
        ecdsaWithSha256,
        name,
        sequence(utcTime(new Date(now - 3600_000)), utcTime(new Date(now + 24 * 3600_000))),
        name,
        publicKey.export({ type: 'spki', format: 'der' }),
        der(0xa3, sequence(subjectAltName)));
    const signature = crypto.sign('sha256', toBeSigned, privateKey);
    const certificate = sequence(toBeSigned, ecdsaWithSha256, der(0x03, Buffer.from([0]), signature));
    return {
        key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        cert: pem('CERTIFICATE', certificate),
    };
}
