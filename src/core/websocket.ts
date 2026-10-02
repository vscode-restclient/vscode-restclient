/**
 * WebSocket básico (#173 del original, +28 votos), con la sintaxis de
 * JetBrains: `WEBSOCKET wss://host/ruta`, cabeceras, y los mensajes en el
 * cuerpo separados por líneas `===`.
 *
 * Abre, envía los mensajes en orden, escucha durante `ms` y cierra. Lo que
 * devuelve es una transcripción: `>> ` lo enviado, `<< ` lo recibido. Usa el
 * `WebSocket` global de Node ≥ 22: sin dependencias, y sin él se dice claro.
 * Sin `vscode`: lo usan el editor y el runner.
 */
export interface WsResult {
    transcript: string;
    sent: string[];
    received: string[];
    closedBy: 'timeout' | 'server' | 'error';
    detail?: string;
}

export const DEFAULT_LISTEN_MS = 3000;

/** Los mensajes del cuerpo: separados por líneas `===`; los vacíos no se envían. */
export function bodyMessages(body: string | undefined): string[] {
    if (!body) {
        return [];
    }
    return body.split(/^\s*===\s*$/m).map(m => m.trim()).filter(m => m.length > 0);
}

export function talk(url: string, headers: Record<string, string>, messages: string[], ms: number = DEFAULT_LISTEN_MS): Promise<WsResult> {
    const Ws = (globalThis as { WebSocket?: new (url: string, options?: unknown) => WebSocketMinimo }).WebSocket;
    if (!Ws) {
        return Promise.reject(new Error('WebSocket needs Node 22 or newer (no WebSocket global in this runtime)'));
    }
    return new Promise(resolve => {
        const sent: string[] = [];
        const received: string[] = [];
        const lines: string[] = [];
        let terminado = false;
        let socket: WebSocketMinimo;

        const close = (closedBy: WsResult['closedBy'], detail?: string) => {
            if (terminado) {
                return;
            }
            terminado = true;
            clearTimeout(timer);
            try {
                socket.close();
            } catch { /* ya cerrado */ }
            if (detail) {
                lines.push(`-- ${detail}`);
            }
            resolve({ transcript: lines.join('\n'), sent, received, closedBy, detail });
        };
        const timer = setTimeout(() => close('timeout', `closed after ${ms} ms`), ms);

        try {
            // undici admite cabeceras propias como extensión de la API estándar.
            socket = new Ws(url, { headers: headers });
        } catch (e) {
            clearTimeout(timer);
            resolve({ transcript: `-- ${messageOf(e)}`, sent, received, closedBy: 'error', detail: messageOf(e) });
            return;
        }
        socket.addEventListener('open', () => {
            for (const m of messages) {
                socket.send(m);
                sent.push(m);
                lines.push(`>> ${m}`);
            }
        });
        socket.addEventListener('message', (ev: { data: unknown }) => {
            const text = typeof ev.data === 'string' ? ev.data : `[binary ${(ev.data as { byteLength?: number })?.byteLength ?? '?'} bytes]`;
            received.push(text);
            lines.push(`<< ${text}`);
        });
        socket.addEventListener('close', (ev: { code?: number; reason?: string }) => close('server', `server closed (${ev.code ?? ''}${ev.reason ? ' ' + ev.reason : ''})`));
        socket.addEventListener('error', (ev: { message?: string; error?: unknown }) => close('error', ev.message ?? messageOf(ev.error) ?? 'connection error'));
    });
}

/** Lo que las aserciones necesitan de una transcripción: cuántos mensajes llegaron y cuál fue el último. */
export function readTranscript(text: string): { received: string[]; sent: string[] } {
    const received: string[] = [];
    const sent: string[] = [];
    for (const l of text.split(/\r?\n/)) {
        if (l.startsWith('<< ')) {
            received.push(l.slice(3));
        } else if (l.startsWith('>> ')) {
            sent.push(l.slice(3));
        }
    }
    return { received, sent };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : e === undefined ? undefined : String(e));

interface WebSocketMinimo {
    send(data: string): void;
    close(): void;
    addEventListener(tipo: string, escucha: (ev: never) => void): void;
}
