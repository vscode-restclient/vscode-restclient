import * as assert from 'assert';
import { readAssertions } from '../../core/assertions';
import { checkResponse, reportLines, summarize } from '../../utils/assertionReport';

describe('assertions in the editor', () => {
    const response = {
        statusCode: 404,
        body: '{"token":"abc","total":3}',
        headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': ['a=1', 'b=2'] },
        timingPhases: { total: 12 },
    };

    it('P-82 · checkResponse reads status, body, headers (multi-valued as the runner does) and time from the editor response', () => {
        const results = checkResponse(readAssertions([
            '# @assert status == 404',
            '# @assert body.$.token exists',
            '# @assert header.content-type contains json',
            '# @assert headers.set-cookie == a=1,b=2',
            '# @assert time < 1000',
            '# @assert body.$.total == 4',
        ].join('\n')), response);
        assert.deepStrictEqual(results.map(r => r.passed), [true, true, true, true, true, false]);
        assert.strictEqual(results[5].actual, '3');
        assert.deepStrictEqual(summarize(results), { passed: 5, failed: 1, total: 6 });
    });

    it('P-83 · reportLines gives one OK/FAIL line per assertion, with the actual value for a failure only', () => {
        const results = checkResponse(readAssertions('# @assert status == 404\n# @assert body.$.total == 4'), response);
        assert.deepStrictEqual(reportLines(results), [
            'OK    status == 404',
            'FAIL  body.$.total == 4   ->  3',
        ]);
        // No assertions: nothing to say, and nothing blows up.
        assert.deepStrictEqual(checkResponse([], response), []);
        assert.deepStrictEqual(summarize([]), { passed: 0, failed: 0, total: 0 });
        // A response without timing (a WebSocket transcript built by hand) counts as 0 ms.
        const [slow] = checkResponse(readAssertions('# @assert time < 1'), { ...response, timingPhases: {} });
        assert.strictEqual(slow.passed, true);
    });
});
