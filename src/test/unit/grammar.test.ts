import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// The grammar's regexes are Oniguruma, but the ones below use nothing JavaScript
// lacks, so they are compiled as they are written in the JSON (a leading `(?i)`
// becomes the `i` flag). What the parser accepts must stay highlighted: it
// trims request and header lines and tolerates trailing blanks on metadata.
const grammar = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../syntaxes/http.tmLanguage.json'), 'utf8'));

const compile = (source: string): RegExp =>
    source.startsWith('(?i)') ? new RegExp(source.slice(4), 'i') : new RegExp(source);

const topLevel = (name: string): RegExp =>
    compile(grammar.patterns.find((p: { name?: string }) => p.name === name).match);

// The first metadata pattern that matches wins, as in TextMate; undefined means
// the line falls through to #comments and loses its highlighting.
const metadata = (line: string): RegExpMatchArray | undefined => {
    for (const pattern of grammar.repository.metadata.patterns) {
        const m = line.match(compile(pattern.match));
        if (m) { return m; }
    }
    return undefined;
};

describe('Syntax highlighting grammar', () => {
    it('P-103 · highlights metadata, request, response and header lines despite surrounding whitespace', () => {
        for (const line of ['# @name Nom', '# @name Nom ', '# @name Nom\t', '// @name Nom  ', '  ## @name Nom ']) {
            assert.strictEqual(metadata(line)?.[3], 'Nom', JSON.stringify(line));
        }
        assert.ok(metadata('# @note '), '# @note with a trailing blank');
        const prompt = metadata('# @prompt token Your API token ');
        assert.strictEqual(prompt?.[3], 'token');
        assert.strictEqual(prompt?.[4], 'Your API token');
        assert.strictEqual(metadata('// @prompt token ')?.[3], 'token');

        const request = compile(grammar.repository['request-line'].match);
        for (const line of ['GET https://example.com/a HTTP/1.1', 'GET https://example.com/a HTTP/1.1 ', '  GET https://example.com/a HTTP/1.1']) {
            const m = line.match(request);
            assert.strictEqual(m?.[2], 'https://example.com/a', JSON.stringify(line));
            assert.strictEqual(m?.[3], 'HTTP/1.1', JSON.stringify(line));
        }
        assert.strictEqual('POST https://example.com/a  '.match(request)?.[2], 'https://example.com/a');

        const response = compile(grammar.repository['response-line'].match);
        for (const line of ['HTTP/1.1 200 OK', 'HTTP/1.1  200  OK ', 'HTTP/2 204', 'HTTP/2 204 ']) {
            const m = line.match(response);
            assert.strictEqual(m?.[2], line.includes('200') ? '200' : '204', JSON.stringify(line));
            assert.strictEqual(m?.[3] ?? '', line.includes('OK') ? 'OK' : '', JSON.stringify(line));
        }

        const header = topLevel('http.headers');
        for (const line of ['Content-Type: application/json', 'Content-Type : application/json ', '  Content-Type: application/json']) {
            const m = line.match(header);
            assert.strictEqual(m?.[1], 'Content-Type', JSON.stringify(line));
            assert.strictEqual(m?.[3], 'application/json', JSON.stringify(line));
        }
    });
});
