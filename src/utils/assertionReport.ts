/**
 * The verdict of the `# @assert` lines of a request, for the editor.
 *
 * The runner has evaluated assertions since they existed; Send Request did
 * not (#34). This is the glue: it turns the response the editor has into what
 * `checkAssertions` wants, and the results into lines a person can read, the
 * same way the runner prints them. Nothing here touches the response itself:
 * the verdict is part of the view, not of what is saved or reused.
 */
import { Assertion, AssertionResult, checkAssertions } from '../core/assertions';

/** What the editor's response offers; the subset the assertions need. */
export interface ResponseLike {
    statusCode: number;
    body: string;
    headers: Record<string, string | string[] | undefined>;
    timingPhases: { total?: number };
}

export function checkResponse(assertions: Assertion[], response: ResponseLike): AssertionResult[] {
    // A multi-valued header (set-cookie) reads the way it does in the runner,
    // which hands the raw headers over and gets `String(array)`: comma, no space.
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(response.headers ?? {})) {
        headers[name] = Array.isArray(value) ? value.join(',') : value;
    }
    return checkAssertions(assertions, {
        status: response.statusCode,
        body: response.body,
        headers,
        ms: response.timingPhases?.total ?? 0,
    });
}

export function summarize(results: AssertionResult[]): { passed: number; failed: number; total: number } {
    const passed = results.filter(r => r.passed).length;
    return { passed, failed: results.length - passed, total: results.length };
}

/**
 * One line per assertion: the mark, the assertion as written, and for a
 * failure the value that was actually found, written as the runner writes it
 * (`raw   ->  actual`).
 */
export function reportLines(results: AssertionResult[]): string[] {
    return results.map(r => r.passed
        ? `OK    ${r.assertion.raw}`
        : `FAIL  ${r.assertion.raw}   ->  ${truncate(r.actual)}`);
}

const truncate = (s: string) => (s.length > 90 ? s.slice(0, 87) + '...' : s);
