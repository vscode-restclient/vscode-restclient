/**
 * Server-Sent Events (`text/event-stream`), que es como responden en 2026
 * todas las API de modelos de lenguaje. Petición #493 del original (+44).
 *
 * El formato es de líneas: `event:`, `data:`, `id:`, y un evento termina en
 * una línea en blanco. Varias líneas `data:` seguidas se unen con salto de
 * línea. Las líneas que empiezan por `:` son comentarios (latidos, casi
 * siempre). Sin `vscode`: lo usan el editor, las aserciones y el runner.
 */
export interface SseEvent {
    event?: string;
    data: string;
    id?: string;
}

export function readEvents(text: string): SseEvent[] {
    const fuera: SseEvent[] = [];
    let actual: { event?: string; data: string[]; id?: string } = { data: [] };
    const cerrar = () => {
        if (actual.data.length > 0) {
            fuera.push({ event: actual.event, data: actual.data.join('\n'), id: actual.id });
        }
        actual = { data: [] };
    };
    for (const line of text.split(/\r?\n/)) {
        if (line === '') {
            cerrar();
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
    cerrar();
    return fuera;
}

export function isEventStream(contentType: string | undefined): boolean {
    return /^\s*text\/event-stream/i.test(contentType ?? '');
}
