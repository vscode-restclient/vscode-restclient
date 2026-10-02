/**
 * Assertions about the response, written in the `.http` file itself.
 *
 * The third most upvoted request in the original project (+59 votes since
 * 2018). They live in an `@` comment, like every other piece of metadata, so a
 * file with assertions is still understood by any other tool that reads the
 * format: whatever does not know them ignores them.
 *
 *   # @assert status == 200
 *   # @assert body.$.token exists
 *   # @assert headers.content-type contains json   (o `header.`, da igual)
 *   # @assert time < 2000
 *   # @assert sse.count == 3            (respuestas text/event-stream)
 *   # @assert ws.last contains eco      (transcripciones WebSocket)
 */
import { readEvents } from './sse';
import { readTranscript } from './websocket';

export type Operator = '==' | '!=' | '<' | '>' | 'contains' | 'matches' | 'exists';

export interface Assertion {
    raw: string;
    subject: string;
    operator: Operator;
    expected: string;
}

export interface AssertionResult {
    assertion: Assertion;
    passed: boolean;
    actual: string;
}

export interface CheckableResponse {
    status?: number;
    body?: string;
    headers?: Record<string, string | undefined>;
    ms: number;
}

const LINE_RE = /^[ \t]*(?:#|\/\/)[ \t]*@assert[ \t]+(.+?)[ \t]*$/gm;
const PARTS = /^(\S+)[ \t]+(==|!=|<|>|contains|matches|exists)[ \t]*(.*)$/;
// Writing `header.` in the singular is the natural thing to do: there is one
// header. Both forms are accepted rather than failing an assertion over an `s`.
const HEADER_PREFIXES = ['headers.', 'header.'];

export function readAssertions(block: string): Assertion[] {
    const fuera: Assertion[] = [];
    LINE_RE.lastIndex = 0;
    for (const m of block.matchAll(LINE_RE)) {
        const p = PARTS.exec(m[1]);
        if (p) {
            fuera.push({ raw: m[1], subject: p[1], operator: p[2] as Operator, expected: p[3] ?? '' });
        }
    }
    return fuera;
}

/**
 * Resolves the subject of an assertion against the response.
 *
 * It reuses the syntax that already exists for request variables
 * (`body.$.field`, `headers.name`), plus `status` and `time`, so that there are
 * not two different languages inside the same file.
 */
export function valueFor(subject: string, r: CheckableResponse): string {
    if (subject === 'status') {
        return String(r.status ?? '');
    }
    if (subject === 'time') {
        return String(r.ms);
    }
    const prefijoCabecera = HEADER_PREFIXES.find(pre => subject.startsWith(pre));
    if (prefijoCabecera) {
        const name = subject.slice(prefijoCabecera.length).toLowerCase();
        const headers = r.headers ?? {};
        const key = Object.keys(headers).find(k => k.toLowerCase() === name);
        return key ? String(headers[key] ?? '') : '';
    }
    if (subject === 'body' || subject === 'body.*') {
        return r.body ?? '';
    }
    if (subject.startsWith('sse.')) {
        const events = readEvents(r.body ?? '');
        switch (subject.slice(4)) {
            case 'count': return String(events.length);
            case 'first': return events[0]?.data ?? '';
            case 'last': return events[events.length - 1]?.data ?? '';
            default: return '';
        }
    }
    if (subject.startsWith('ws.')) {
        const { received } = readTranscript(r.body ?? '');
        switch (subject.slice(3)) {
            case 'count': return String(received.length);
            case 'first': return received[0] ?? '';
            case 'last': return received[received.length - 1] ?? '';
            default: return '';
        }
    }
    if (subject.startsWith('body.$')) {
        return porRuta(r.body, subject.slice('body.$'.length).replace(/^\./, ''));
    }
    return '';
}

/** Camino sencillo dentro de un JSON: `a.b[0].c`. Sin JSONPath completo. */
function porRuta(body: string | undefined, filePath: string): string {
    if (!body) {
        return '';
    }
    let actual: unknown;
    try {
        actual = JSON.parse(body);
    } catch {
        return '';
    }
    if (filePath === '') {
        return typeof actual === 'string' ? actual : JSON.stringify(actual);
    }
    for (const chunk of filePath.split('.')) {
        for (const parte of chunk.split(/\[(\d+)\]/).filter(x => x !== '')) {
            if (actual === null || actual === undefined) {
                return '';
            }
            actual = (actual as Record<string, unknown>)[parte];
        }
    }
    if (actual === undefined || actual === null) {
        return '';
    }
    return typeof actual === 'string' ? actual : JSON.stringify(actual);
}

/**
 * Is this a subject we know how to resolve? A misspelt `header.content-tipe`
 * used to be worth '', and the assertion failed as if the server were at fault;
 * worse still with `!=`, where it passed and the file looked green.
 */
export function isKnownSubject(subject: string): boolean {
    return subject === 'status'
        || subject === 'time'
        || subject === 'body'
        || subject === 'body.*'
        || subject.startsWith('body.$')
        || /^(sse|ws).(count|first|last)$/.test(subject)
        || HEADER_PREFIXES.some(pre => subject.startsWith(pre) && subject.length > pre.length);
}

export function checkAssertions(assertions: Assertion[], r: CheckableResponse): AssertionResult[] {
    return assertions.map(a => {
        if (!isKnownSubject(a.subject)) {
            return { assertion: a, passed: false, actual: `no sé qué es "${a.subject}"` };
        }
        const actual = valueFor(a.subject, r);
        const e = a.expected;
        let passed: boolean;
        switch (a.operator) {
            case '==': passed = actual === e; break;
            case '!=': passed = actual !== e; break;
            case '<': passed = Number(actual) < Number(e); break;
            case '>': passed = Number(actual) > Number(e); break;
            case 'contains': passed = actual.includes(e); break;
            case 'matches': passed = matchesSafely(actual, e); break;
            case 'exists': passed = actual !== ''; break;
            default: passed = false;
        }
        return { assertion: a, passed, actual };
    });
}

/**
 * A regular expression written by the user must not be able to hang the editor:
 * both the pattern and the text are bounded before it is evaluated. An invalid
 * pattern fails the assertion instead of throwing.
 */
function matchesSafely(text: string, pattern: string): boolean {
    if (pattern.length === 0 || pattern.length > 200) {
        return false;
    }
    try {
        return new RegExp(pattern).test(text.slice(0, 100_000));
    } catch {
        return false;
    }
}
