import * as assert from 'assert';
import { digest } from '../../utils/auth/digest';
import { md5 } from '../../utils/misc';

// Digest signs the request URI. The URI is the path WITH the query string
// (RFC 7616 §3.4): drop the query and the server computes a different hash
// and answers 401 again. This pins that down before url.parse() goes away.
describe('Digest auth · the signed URI keeps the query string', () => {
    const challengeFor = (url: string) => ({
        statusCode: 401,
        headers: { 'www-authenticate': 'Digest realm="api", nonce="abc123"' },
        url,
        request: { options: { method: 'GET' } },
    });

    function authorizationFor(url: string): string {
        let merged: any;
        const result = digest('alice', 'secret')(challengeFor(url) as any, (options: any) => { merged = options; return 'retried' as any; });
        assert.strictEqual(result, 'retried', 'the hook retries with the Authorization header');
        return merged.headers.authorization as string;
    }

    it('puts path and query in uri= and in the response hash', () => {
        const authorization = authorizationFor('http://h/digest/items?page=2&size=5');
        assert.ok(authorization.startsWith('Digest '));
        assert.ok(authorization.includes('uri="/digest/items?page=2&size=5"'), authorization);
        const ha1 = md5('alice:api:secret');
        const ha2 = md5('GET:/digest/items?page=2&size=5');
        assert.ok(authorization.includes(`response="${md5(`${ha1}:abc123:${ha2}`)}"`), 'the hash covers the query string');
    });

    it('signs the bare path when there is no query string', () => {
        const authorization = authorizationFor('http://h/digest/items');
        assert.ok(authorization.includes('uri="/digest/items"'), authorization);
    });

    it('leaves any other response alone', () => {
        const response = { statusCode: 200, headers: {}, url: 'http://h/x', request: { options: { method: 'GET' } } };
        assert.strictEqual(digest('a', 'b')(response as any, () => { throw new Error('must not retry'); }), response);
    });
});
