import * as assert from 'assert';
import { allowsUnresolved, blockingUnresolved, unresolvedSummary, unresolvedVariables } from '../../core/variables';

const BR = String.fromCharCode(10);
const j = (...l: string[]) => l.join(BR);

// P-96: a variable that is still `{{name}}` when the request is about to go
// is an error, in the editor and in the runner alike, unless the request says
// `# @allow-unresolved`.
describe('unresolved variables', () => {
    it('P-96 · lists what is still {{…}} in what will be sent, in order, once each', () => {
        const text = j('GET {{host}}/items/{{id}}?x={{id}}', 'Authorization: Bearer {{ token }}', '', '{"ref": "{{host}}"}');
        assert.deepStrictEqual(unresolvedVariables(text), ['host', 'id', 'token']);
        assert.deepStrictEqual(unresolvedVariables('GET http://h/items'), []);
    });

    it('P-96 · comments above the request and metadata comments anywhere do not count: they are not sent', () => {
        const text = j('# see {{docs}} for the shape', '// {{also}}', 'GET http://h/items', '', '{"a": 1}', '', '# @assert body.$.x == {{expected}}', '// @name {{nope}}');
        assert.deepStrictEqual(unresolvedVariables(text), []);
    });

    it('P-96 · definitions and imports above the request are not sent, nor is a comment after them', () => {
        const text = j('import ./lib.http', '@secret = {{$dotenv UNUSED}}', '', '# login uses {{docs}}', 'GET http://h/a');
        assert.deepStrictEqual(unresolvedVariables(text), []);
        assert.strictEqual(allowsUnresolved(j('@host = http://h', 'import ./lib.http', '# @allow-unresolved', 'GET {{host}}/x')), true);
    });

    it('P-96 · a body line that starts with # is body, and counts', () => {
        const markdown = j('POST http://h/notes', 'Content-Type: text/markdown', '', '# Title of {{project}}', '// not a comment either: {{x}}');
        assert.deepStrictEqual(unresolvedVariables(markdown), ['project', 'x']);
    });

    it('P-96 · system variables left over count too: a malformed one is a mistake, not text', () => {
        assert.deepStrictEqual(unresolvedVariables('GET http://h/{{$randomInt 1}}/{{$dotenv}}'), ['$randomInt 1', '$dotenv']);
    });

    it('P-96 · "# @allow-unresolved" above the request sends the text as it is', () => {
        const body = j('POST http://h/render', '', '{"template": "Hello {{name}}"}');
        assert.deepStrictEqual(blockingUnresolved(body), ['name']);
        for (const setting of ['# @allow-unresolved', '// @allow-unresolved', '#@allow-unresolved', '# @Allow-Unresolved', '# @allow-unresolved yes  ']) {
            assert.deepStrictEqual(blockingUnresolved(j(setting, body)), [], setting);
            assert.deepStrictEqual(blockingUnresolved(j('# @name render', '', setting, body)), [], `${setting} after a blank line`);
        }
        assert.strictEqual(allowsUnresolved(j('# @allow-unresolved-not', body)), false);
        // Below the request line it is not a setting, as in the editor.
        assert.strictEqual(allowsUnresolved(j(body, '# @allow-unresolved')), false);
    });

    it('P-96 · the summary names them, singular or plural', () => {
        assert.strictEqual(unresolvedSummary(['host']), 'unresolved variable: host');
        assert.strictEqual(unresolvedSummary(['host', 'token']), 'unresolved variables: host, token');
    });
});
