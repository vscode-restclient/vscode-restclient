import * as assert from 'assert';
import { Imported, variablesWithImports } from '../../core/imports';
import { allowsUnresolved, blockingUnresolved, fileVariableValue, unresolvedSummary, unresolvedVariables } from '../../core/variables';

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

// P-104: a file variable may be written in double or single quotes, which keep
// what a bare value loses (the blanks around it, or being empty). The editor
// and the runner read the value through the same function.
describe('quoted file variables', () => {
    it('P-104 · double or single quotes go, and the blanks inside them stay', () => {
        assert.strictEqual(fileVariableValue(' "api.example.com" '), 'api.example.com');
        assert.strictEqual(fileVariableValue("'api.example.com'"), 'api.example.com');
        assert.strictEqual(fileVariableValue('"  padded  "'), '  padded  ');
        assert.strictEqual(fileVariableValue("'  padded  '"), '  padded  ');
        assert.strictEqual(fileVariableValue('""'), '');
        assert.strictEqual(fileVariableValue("''"), '');
        assert.strictEqual(fileVariableValue('  bare value  '), 'bare value');
    });

    it('P-104 · an escaped quote stays inside, and the other kind needs no escape', () => {
        assert.strictEqual(fileVariableValue('"say \\"hi\\""'), 'say "hi"');
        assert.strictEqual(fileVariableValue("'it\\'s'"), "it's");
        assert.strictEqual(fileVariableValue(`"it's"`), "it's");
        assert.strictEqual(fileVariableValue(`'say "hi"'`), 'say "hi"');
        assert.strictEqual(fileVariableValue('"a\\tb\\nc"'), 'a\tb\nc');
    });

    it('P-104 · quotes that do not wrap the whole value are text', () => {
        assert.strictEqual(fileVariableValue('"a" "b"'), '"a" "b"');
        assert.strictEqual(fileVariableValue('"open'), '"open');
        assert.strictEqual(fileVariableValue('"'), '"');
        assert.strictEqual(fileVariableValue('{"id": 1}'), '{"id": 1}');
        assert.strictEqual(fileVariableValue('x = "y"'), 'x = "y"');
        assert.strictEqual(fileVariableValue('"a\\"'), '"a"');
    });

    it('P-104 · the runner reads them the same way, imports included', () => {
        const text = j('@host = "api.example.com"', "@pad = '  x  '", '@empty = ""', '@bare =  plain  ', 'GET https://{{host}}');
        assert.deepStrictEqual(variablesWithImports(text, [{ text: "@shared = 'from import'" } as Imported]),
            { shared: 'from import', host: 'api.example.com', pad: '  x  ', empty: '', bare: 'plain' });
    });
});
