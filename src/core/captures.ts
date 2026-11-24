// `# @set name = response.body.$.token`: a value taken from a response and
// kept for the requests that follow, in this file and in any other. Shared by
// the editor, the terminal runner and the MCP server, so that the three read
// the same lines and take the same values. No `vscode` here.
//
// What a captured value is, in one sentence: it takes the place of the
// selected environment's value for the rest of the session. Whatever beats
// the environment (a file's `@name = …`, `--var` in the runner) beats it too,
// and it belongs to the environment that was selected when it was taken, so
// a token taken against `dev` is never sent to `prod`. It lives in memory
// only: an editor window, a runner invocation, an MCP server process.
//
// The syntax is the one rest-client-next uses, so its files keep working:
// `response.body.<path>` and `response.headers.<name>`. The path language is
// the one `# @assert` uses (`body.$.a.b[0]`, `headers.name`), which is what
// makes the editor and the runner take the same value from the same response;
// the `response.` prefix is optional.
import { CheckableResponse, isKnownSubject, valueFor } from './assertions';

export interface Capture {
    /** The line as written after `@set`. */
    raw: string;
    /** The variable it sets; empty when the line could not be read. */
    name: string;
    /** What it takes from the response, as an assertion subject (`body.$.token`). */
    subject: string;
    /** Why the line cannot be applied, when it cannot. */
    problem?: string;
}

export interface CaptureResult {
    capture: Capture;
    /** The value taken, when there was one. */
    value?: string;
    /** Why nothing was taken. The variable keeps whatever it had. */
    error?: string;
}

/** `@set` followed by a blank: `@settings` is not one. */
const LINE_RE = /^[ \t]*(?:#|\/\/)[ \t]*@set(?:[ \t]+(.*?))?[ \t]*$/gm;
const NAME_RE = /^[A-Za-z_][\w-]*$/;
const USAGE = 'expected "# @set name = response.body.$.path" or "# @set name = response.headers.Name"';

/** The `# @set` lines of a block, in order, the ones that cannot be applied included. */
export function readCaptures(block: string): Capture[] {
    const out: Capture[] = [];
    LINE_RE.lastIndex = 0;
    for (const m of block.matchAll(LINE_RE)) {
        out.push(parseCapture((m[1] ?? '').trim()));
    }
    return out;
}

/**
 * `name = source`. Only the first `=` separates: a JSON path may hold more
 * (`$.items[?(@.id=='x')]`), and the name never does.
 */
export function parseCapture(raw: string): Capture {
    const at = raw.indexOf('=');
    if (at <= 0) {
        return { raw, name: '', subject: '', problem: USAGE };
    }
    const name = raw.slice(0, at).trim();
    const source = raw.slice(at + 1).trim();
    if (!NAME_RE.test(name)) {
        return { raw, name: '', subject: '', problem: `"${name}" is not a variable name: letters, digits, _ and -, not starting with a digit` };
    }
    if (/^request\./i.test(source)) {
        return { raw, name, subject: '', problem: 'only the response can be captured: the request is what you wrote' };
    }
    const subject = source.replace(/^response\./i, '');
    if (subject === '' || !isKnownSubject(subject)) {
        return { raw, name, subject, problem: `unknown source "${source}"; ${USAGE}` };
    }
    return { raw, name, subject };
}

/**
 * The captures of a block that may be a `run #name`: those of the request it
 * runs, then the block's own, so the block can override a target. Read from
 * the text as written, before any variable is substituted.
 */
export function capturesOf(written: string, run?: string): Capture[] {
    return run === undefined || run === written
        ? readCaptures(written)
        : [...readCaptures(run), ...readCaptures(written)];
}

/** The names a text sets, for the editor to know `{{token}}` is coming. */
export function captureTargets(text: string): string[] {
    return [...new Set(readCaptures(text).filter(c => !c.problem).map(c => c.name))];
}

/**
 * Takes the values from the response into `into`. A source that finds
 * nothing (an absent header, a path that does not match, an empty value)
 * sets nothing: the variable keeps what it had, and the result says why.
 */
export function applyCaptures(captures: readonly Capture[], response: CheckableResponse, into: Map<string, string>): CaptureResult[] {
    return captures.map(capture => {
        if (capture.problem) {
            return { capture, error: capture.problem };
        }
        const value = valueFor(capture.subject, response);
        if (value === '') {
            return { capture, error: `nothing found at ${capture.subject}` };
        }
        into.set(capture.name, value);
        return { capture, value };
    });
}

/** One line per capture that took nothing: `@set token = …   ->  why`. */
export function captureFailures(results: readonly CaptureResult[]): string[] {
    return results.filter(r => r.error !== undefined).map(r => `@set ${r.capture.raw}   ->  ${r.error}`);
}

/**
 * The captured values of a session, one set per scope (the selected
 * environment, and in the editor the workspace folder too). Nothing is
 * written to disk.
 */
export class CaptureStore {
    private readonly scopes = new Map<string, Map<string, string>>();

    /** The values of a scope; the same Map every time, created empty. */
    public scope(key: string): Map<string, string> {
        let values = this.scopes.get(key);
        if (!values) {
            values = new Map();
            this.scopes.set(key, values);
        }
        return values;
    }

    public clear(): void {
        this.scopes.clear();
    }
}
