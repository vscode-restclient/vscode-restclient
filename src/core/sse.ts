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
    const out: SseEvent[] = [];
    let actual: { event?: string; data: string[]; id?: string } = { data: [] };
    const close = () => {
        if (actual.data.length > 0) {
            out.push({ event: actual.event, data: actual.data.join('\n'), id: actual.id });
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
        const cutoff = line.indexOf(':');
        const field = cutoff < 0 ? line : line.slice(0, cutoff);
        const value = cutoff < 0 ? '' : line.slice(cutoff + 1).replace(/^ /, '');
        if (field === 'data') {
            actual.data.push(value);
        } else if (field === 'event') {
            actual.event = value;
        } else if (field === 'id') {
            actual.id = value;
        }
    }
    close();
    return out;
}

export function isEventStream(contentType: string | undefined): boolean {
    return /^\s*text\/event-stream/i.test(contentType ?? '');
}
