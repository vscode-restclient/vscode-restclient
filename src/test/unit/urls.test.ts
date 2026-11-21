import * as assert from 'assert';
import { bareHostname, explicitPort, hasProtocol, hostAsWritten, pathAsWritten, pathWithQuery, queryParameters, requestOutline, resolveAgainst, tryParseUrl } from '../../core/urls';

// The replacement of url.parse() by the URL class must not change what the
// certificate settings, the proxy exclusions, Digest and the outline see.
describe('URL helpers (url.parse replacement)', () => {
    it('parses absolute URLs and yields undefined for anything else', () => {
        assert.strictEqual(tryParseUrl('https://foo.com/a?b=1')?.hostname, 'foo.com');
        for (const text of ['not a url', '/api/items', 'foo.com/x', 'localhost:3000/x', '']) {
            assert.strictEqual(tryParseUrl(text), undefined, text);
        }
    });

    it('recognises a scheme only when it is followed by //', () => {
        for (const text of ['https://x', 'HTTP://x/y', 'ws://x', ' http://x']) {
            assert.strictEqual(hasProtocol(text), true, text);
        }
        // url.parse() took `localhost:` for a protocol, so copy-as-cURL sent
        // the snippet generator a URL it rejected (upstream #328).
        for (const text of ['localhost:3000/api', '/api', 'example.com/x', 'mailto:x', '']) {
            assert.strictEqual(hasProtocol(text), false, text);
        }
    });

    it('keeps an explicitly written default port, which URL drops', () => {
        const port = (text: string) => explicitPort(text, tryParseUrl(text)!);
        assert.strictEqual(port('https://foo.com:443/'), '443');
        assert.strictEqual(port('http://foo.com:80/x'), '80');
        assert.strictEqual(port('https://foo.com:8443/'), '8443');
        assert.strictEqual(port('https://foo.com/'), undefined);
        assert.strictEqual(port('https://[::1]:443/'), '443');
        assert.strictEqual(port('https://[::1]/'), undefined);
        assert.strictEqual(port('https://user:secret@foo.com:80/x'), '80');
        assert.strictEqual(port('https://foo.com:443?x=1'), '443');
        assert.strictEqual(port('https://foo.com:443#frag'), '443');
    });

    it('rebuilds host as url.parse() returned it', () => {
        const host = (text: string) => hostAsWritten(text, tryParseUrl(text)!);
        assert.strictEqual(host('https://foo.com:443/'), 'foo.com:443');
        assert.strictEqual(host('https://foo.com/'), 'foo.com');
        assert.strictEqual(host('https://[::1]:8443/'), '[::1]:8443');
        assert.strictEqual(host('https://FOO.com:8443/'), 'foo.com:8443');
    });

    it('strips the brackets of an IPv6 literal, as url.parse().hostname did', () => {
        const bare = (text: string) => bareHostname(text, tryParseUrl(text)!);
        assert.strictEqual(bare('https://[::1]:8443/'), '::1');
        assert.strictEqual(bare('https://foo.com/'), 'foo.com');
    });

    it('keeps the host and the port as written, where URL would canonicalise them', () => {
        // A certificate key or a proxy exclusion written like this matched before and must still match.
        const host = (text: string) => hostAsWritten(text, tryParseUrl(text)!);
        assert.strictEqual(host('https://[0:0:0:0:0:0:0:1]:8443/'), '[0:0:0:0:0:0:0:1]:8443');
        assert.strictEqual(host('https://[::ffff:127.0.0.1]/'), '[::ffff:127.0.0.1]');
        assert.strictEqual(host('http://0x7f.1/'), '0x7f.1');
        assert.strictEqual(host('http://foo.com:08080/'), 'foo.com:08080');
        assert.strictEqual(explicitPort('http://foo.com:08080/', tryParseUrl('http://foo.com:08080/')!), '08080');
        assert.strictEqual(bareHostname('https://[0:0:0:0:0:0:0:1]:8443/', tryParseUrl('https://[0:0:0:0:0:0:0:1]:8443/')!), '0:0:0:0:0:0:0:1');
        // An internationalised name is the punycode form, as url.parse() returned it.
        assert.strictEqual(host('https://bücher.de/'), 'xn--bcher-kva.de');
        assert.strictEqual(host('https://user:443@foo.com/'), 'foo.com');
    });

    it('returns the path with its query string as written, for the outline', () => {
        assert.strictEqual(pathAsWritten('https://h/café?q=niño'), '/café?q=niño');
        assert.strictEqual(pathAsWritten('https://h/a/../b/./c'), '/a/../b/./c');
        assert.strictEqual(pathAsWritten("https://h/it's?x=%27"), "/it's?x=%27");
        assert.strictEqual(pathAsWritten('https://h'), '/');
        assert.strictEqual(pathAsWritten('https://h?x=1'), '/?x=1');
        assert.strictEqual(pathAsWritten('https://h/a#frag'), '/a');
        assert.strictEqual(pathAsWritten('https://u:p@h:8443/a?b=1#f'), '/a?b=1');
    });

    it('reads the query parameters of a bare or absolute URL as querystring.parse did', () => {
        assert.deepStrictEqual(queryParameters('/items?a=1&a=2&b=x+y&c=%2B&d'), [['a', '1'], ['a', '2'], ['b', 'x y'], ['c', '+'], ['d', '']]);
        assert.deepStrictEqual(queryParameters('https://h/items?page=2#frag'), [['page', '2']]);
        assert.deepStrictEqual(queryParameters('/items'), []);
        assert.deepStrictEqual(queryParameters('localhost:3000/x?a=1'), [['a', '1']]);
    });

    it('resolves a document link against a file: base as url.resolve() did', () => {
        assert.strictEqual(resolveAgainst('file:///c%3A/Users/x/dir/', 'a.json'), 'file:///c%3A/Users/x/dir/a.json');
        assert.strictEqual(resolveAgainst('file:///c%3A/Users/x/dir/', '../a.json'), 'file:///c%3A/Users/x/a.json');
        assert.strictEqual(resolveAgainst('file:///home/x/dir/', 'sub/a b.json'), 'file:///home/x/dir/sub/a%20b.json');
        assert.strictEqual(resolveAgainst('file:///home/x/dir/', './a.json'), 'file:///home/x/dir/a.json');
        assert.strictEqual(resolveAgainst('', 'a.json'), 'a.json');
    });

    it('labels a request for the outline: path with query, host with its port, bare paths as written', () => {
        assert.deepStrictEqual(requestOutline('GET', 'https://api.example.com:8443/items?page=2'), { name: 'GET /items?page=2', host: 'api.example.com:8443' });
        assert.deepStrictEqual(requestOutline('GET', 'https://api.example.com:443/items'), { name: 'GET /items', host: 'api.example.com:443' });
        assert.deepStrictEqual(requestOutline('POST', '/api/items?x=1'), { name: 'POST /api/items?x=1', host: '' });
        // url.parse() took `localhost:` for a scheme and showed "GET 3000/api".
        assert.deepStrictEqual(requestOutline('GET', 'localhost:3000/api'), { name: 'GET localhost:3000/api', host: '' });
        assert.deepStrictEqual(requestOutline('GET', 'example.com/x'), { name: 'GET example.com/x', host: '' });
        assert.deepStrictEqual(requestOutline('GET', 'https://h/buscar?q=niño'), { name: 'GET /buscar?q=niño', host: 'h' });
    });

    it('returns the path with its query string, as url.parse().path did', () => {
        assert.strictEqual(pathWithQuery(tryParseUrl('http://h/items?page=2&size=5')!), '/items?page=2&size=5');
        assert.strictEqual(pathWithQuery(tryParseUrl('http://h')!), '/');
        assert.strictEqual(pathWithQuery(tryParseUrl('http://h/a#frag')!), '/a');
    });
});
