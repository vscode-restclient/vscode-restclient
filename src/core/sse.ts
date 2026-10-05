/**
 * Server-Sent Events (`text/event-stream`), which is how every language-model
 * API answers in 2026. Upstream request #493 (+44).
 *
 * The format is line-based: `event:`, `data:`, `id:`, and an event ends at a
 * blank line. Consecutive `data:` lines are joined with a line break. Lines
 * starting with `:` are comments (heartbeats, almost always). No `vscode`
 * import: the editor, the assertions and the runner all use this.
 */
export interface SseEvent {
    event?: string;
    data: string;
    id?: string;
}

export function readEvents(text: string): SseEvent[] {
    const fuera: SseEvent[] = [];
    let actual: { event?: string; data: string[]; id?: string } = { data: [] };
    const close = () => {
        if (actual.data.length > 0) {
            fuera.push({ event: actual.event, data: actual.data.join('\n'), id: actual.id });
        }
        actual = { data: [] };
    };
    for (const line of text.split(/\r?\n/)) {
        if (line === '') {
            close();
            continue;
        }
        if (line.startsWith(':')) {
            continue;
        }
        const corte = line.indexOf(':');
        const campo = corte < 0 ? line : line.slice(0, corte);
        const value = corte < 0 ? '' : line.slice(corte + 1).replace(/^ /, '');
        if (campo === 'data') {
            actual.data.push(value);
        } else if (campo === 'event') {
            actual.event = value;
        } else if (campo === 'id') {
            actual.id = value;
        }
    }
    close();
    return fuera;
}

export function isEventStream(contentType: string | undefined): boolean {
    return /^\s*text\/event-stream/i.test(contentType ?? '');
}
