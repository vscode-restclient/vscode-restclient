import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
    findHostCertificate, HostCertificateConflictError, HostCertificateSettings, HOST_CERTIFICATE_KEY_PATTERN
} from '../../core/hostCertificateMatcher';

function match(requestUrl: string, keys: string[]): string | undefined {
    const certificates: Record<string, HostCertificateSettings> = {};
    for (const key of keys) {
        certificates[key] = {};
    }
    return findHostCertificate(requestUrl, certificates)?.key;
}

describe('host certificate matching', () => {
    describe('exact hosts', () => {
        it('matches hosts and ports without matching subdomains', () => {
            assert.strictEqual(match('https://foo.com/a', ['foo.com']), 'foo.com');
            assert.strictEqual(match('https://a.foo.com/', ['foo.com']), undefined);
            assert.strictEqual(match('https://foo.com/', ['a.foo.com']), undefined);
            assert.strictEqual(match('https://foo.com:8443/', ['foo.com:8443']), 'foo.com:8443');
            assert.strictEqual(match('https://foo.com:9000/', ['foo.com:8443']), undefined);
        });

        it('requires an absent port to match an absent port', () => {
            assert.strictEqual(match('https://foo.com:8443/', ['foo.com']), undefined);
            assert.strictEqual(match('https://foo.com/', ['foo.com:8443']), undefined);
        });

        it('preserves explicitly written default ports', () => {
            assert.strictEqual(match('https://foo.com:443/', ['foo.com']), undefined);
            assert.strictEqual(match('https://foo.com/', ['foo.com:443']), undefined);
            assert.strictEqual(match('https://foo.com:443/', ['foo.com:443']), 'foo.com:443');
            assert.strictEqual(match('http://foo.com:80/', ['foo.com:80']), 'foo.com:80');
        });

        it('keeps IPv6 and unusual hosts opaque', () => {
            assert.strictEqual(match('https://[::1]:8443/', ['[::1]:8443']), '[::1]:8443');
            assert.strictEqual(match('https://my_host/', ['my_host']), 'my_host');
        });

        it('ignores case for all key forms and URL hosts', () => {
            for (const key of ['Foo.COM', 'Foo.COM:*', '*.COM', '**.COM:*']) {
                assert.strictEqual(match('https://FOO.com/', [key]), key);
            }
            assert.strictEqual(match('https://[ABCD::1]:8443/', ['[abcd::1]:8443']), '[abcd::1]:8443');
        });
    });

    describe('host wildcards', () => {
        it('matches exactly one additional label for *.', () => {
            assert.strictEqual(match('https://a.example.com/', ['*.example.com']), '*.example.com');
            assert.strictEqual(match('https://a.b.example.com/', ['*.example.com']), undefined);
        });

        it('matches one or more additional labels for **.', () => {
            for (const host of ['a.example.com', 'a.b.c.example.com']) {
                assert.strictEqual(match(`https://${host}/`, ['**.example.com']), '**.example.com');
            }
        });

        it('neither wildcard matches the apex, partial suffixes or empty labels', () => {
            for (const wildcard of ['*', '**']) {
                for (const host of ['example.com', 'notexample.com', '.example.com', 'a..example.com']) {
                    assert.strictEqual(match(`https://${host}/`, [`${wildcard}.example.com`]), undefined);
                }
            }
        });

        it('both host wildcards apply exact numeric ports', () => {
            for (const wildcard of ['*', '**']) {
                const key = `${wildcard}.example.com:8443`;
                assert.strictEqual(match('https://a.example.com:8443/', [key]), key);
                assert.strictEqual(match('https://a.example.com:9000/', [key]), undefined);
                assert.strictEqual(match('https://a.example.com/', [key]), undefined);
                assert.strictEqual(match('https://a.example.com:8443/', [`${wildcard}.example.com`]), undefined);
            }
        });
    });

    describe('port wildcards', () => {
        it('matches any port or no port, with or without host wildcards', () => {
            for (const key of ['foo.example.com:*', '*.example.com:*', '**.example.com:*']) {
                for (const port of ['', ':443', ':8443', ':1']) {
                    assert.strictEqual(match(`https://foo.example.com${port}/`, [key]), key);
                }
            }
        });

        it('supports bracketed IPv6 and opaque exact hosts', () => {
            assert.strictEqual(match('https://[::1]:8443/', ['[::1]:*']), '[::1]:*');
            assert.strictEqual(match('https://[::1]/', ['[::1]:*']), '[::1]:*');
            assert.strictEqual(match('https://MY_host:443/', ['my_host:*']), 'my_host:*');
            assert.strictEqual(match('https://bar.example.com/', ['foo.example.com:*']), undefined);
        });
    });

    describe('precedence independent of settings order', () => {
        const cases: [string, string[], string][] = [
            ['https://a.example.com/', ['**.example.com', '*.example.com', 'a.example.com'], 'a.example.com'],
            ['https://b.example.com/', ['**.example.com', '*.example.com', 'a.example.com'], '*.example.com'],
            ['https://x.b.example.com/', ['**.example.com', '*.example.com'], '**.example.com'],
            ['https://x.api.example.com/', ['**.example.com', '**.api.example.com'], '**.api.example.com'],
            ['https://a.example.com:8443/', ['*.example.com:8443', 'a.example.com:*'], 'a.example.com:*'],
            ['https://a.example.com:8443/', ['**.example.com:8443', '*.example.com:*'], '*.example.com:*'],
            ['https://x.api.example.com:8443/', ['**.example.com:8443', '**.api.example.com:*'], '**.api.example.com:*'],
            ['https://foo.com:8443/', ['foo.com:*', 'foo.com:8443'], 'foo.com:8443'],
            ['https://foo.com/', ['foo.com:*', 'foo.com'], 'foo.com'],
            ['https://a.example.com/', ['*.example.com:*', '*.example.com'], '*.example.com'],
            ['https://a.example.com:8443/', ['*.example.com:*', '*.example.com:8443'], '*.example.com:8443'],
            ['https://a.b.example.com/', ['**.example.com:*', '**.example.com'], '**.example.com'],
            ['https://a.b.example.com:8443/', ['**.example.com:*', '**.example.com:8443'], '**.example.com:8443']
        ];
        it('ranks host specificity before ports in either settings order', () => {
            for (const [requestUrl, keys, expected] of cases) {
                for (const order of [keys, [...keys].reverse()]) {
                    assert.strictEqual(match(requestUrl, order), expected, `${requestUrl}: ${order.join(', ')}`);
                }
            }
        });
    });

    describe('case-equivalent duplicates and conflicts', () => {
        const pairs = [
            ['foo.example.com', 'FOO.EXAMPLE.COM'],
            ['foo.example.com:*', 'FOO.EXAMPLE.COM:*'],
            ['*.example.com', '*.EXAMPLE.COM'],
            ['**.example.com', '**.EXAMPLE.COM'],
            ['*.example.com:8443', '*.EXAMPLE.COM:8443'],
            ['**.example.com:*', '**.EXAMPLE.COM:*']
        ];
        it('accepts identical settings for all case-equivalent key forms', () => {
            for (const [lower, upper] of pairs) {
                const requestUrl = `https://foo.example.com${lower.endsWith(':8443') ? ':8443' : ''}/`;
                const value = { cert: 'client.crt', key: 'client.key', pfx: 'client.pfx', passphrase: 'secret' };
                const certificates = { [lower]: value, [upper]: { ...value } };
                const expected = { key: [lower, upper].sort()[0], value };
                assert.deepStrictEqual(findHostCertificate(requestUrl, certificates), expected);
                assert.deepStrictEqual(findHostCertificate(requestUrl, { [upper]: { ...value }, [lower]: value }), expected);
            }
        });

        it('rejects conflicting settings for all case-equivalent key forms in either order', () => {
            for (const [lower, upper] of pairs) {
                const requestUrl = `https://foo.example.com${lower.endsWith(':8443') ? ':8443' : ''}/`;
                for (const keys of [[lower, upper], [upper, lower]]) {
                    const certificates = { [keys[0]]: { cert: 'a.crt' }, [keys[1]]: { cert: 'b.crt' } };
                    assert.throws(() => findHostCertificate(requestUrl, certificates), HostCertificateConflictError);
                }
            }
        });

        it('compares all four fields directly, including missing versus empty values', () => {
            for (const field of ['cert', 'key', 'pfx', 'passphrase'] as const) {
                for (const value of ['different-path-or-secret', '']) {
                    assert.throws(() => findHostCertificate('https://foo.com/', {
                        'foo.com': {}, 'FOO.COM': { [field]: value }
                    }), HostCertificateConflictError);
                }
            }
        });

        it('ignores unrelated fields and object identity when comparing duplicates', () => {
            assert.ok(findHostCertificate('https://foo.com/', {
                'foo.com': { cert: 'client.crt', extra: 'a' },
                'FOO.COM': { cert: 'client.crt', key: undefined, extra: 'b' }
            }));
        });

        it('does not fall back to a broader wildcard or to sending without a certificate', () => {
            const fallbacks: Record<string, HostCertificateSettings>[] = [{}, { '**.example.com': { cert: 'fallback.crt' } }];
            for (const fallback of fallbacks) {
                assert.throws(() => findHostCertificate('https://foo.example.com/', {
                    ...fallback, '*.example.com': { cert: 'a.crt' }, '*.EXAMPLE.COM': { cert: 'b.crt' }
                }), HostCertificateConflictError);
            }
        });

        it('does not expose certificate fields in errors', () => {
            assert.throws(() => findHostCertificate('https://foo.com/', {
                'foo.com': { cert: 'CERTIFICATE-CONTENT', key: 'PRIVATE-KEY', pfx: 'PFX-CONTENT', passphrase: 'SECRET' },
                'FOO.COM': {}
            }), (error: unknown) => {
                assert.ok(error instanceof HostCertificateConflictError);
                assert.deepStrictEqual(error.keys, ['FOO.COM', 'foo.com']);
                const text = JSON.stringify(error) + error.message + error.stack;
                for (const secret of ['CERTIFICATE-CONTENT', 'PRIVATE-KEY', 'PFX-CONTENT', 'SECRET']) {
                    assert.ok(!text.includes(secret));
                }
                assert.ok(error.message.includes('foo.com') && error.message.includes('FOO.COM'));
                return true;
            });
        });

        it('allows more-specific matches and unaffected requests despite conflicts', () => {
            const certificates = {
                '**.example.com:*': { cert: 'a.crt' }, '**.EXAMPLE.COM:*': { cert: 'b.crt' },
                '*.example.com:*': { cert: 'single.crt' },
                '**.api.example.com:*': { cert: 'api.crt' },
                'foo.example.com:*': { cert: 'exact.crt' }
            };
            for (const entries of [certificates, Object.fromEntries(Object.entries(certificates).reverse())]) {
                assert.strictEqual(findHostCertificate('https://foo.example.com:8443/', entries)?.value.cert, 'exact.crt');
                assert.strictEqual(findHostCertificate('https://bar.example.com:8443/', entries)?.value.cert, 'single.crt');
                assert.strictEqual(findHostCertificate('https://x.api.example.com:8443/', entries)?.value.cert, 'api.crt');
                assert.strictEqual(findHostCertificate('https://elsewhere.com/', entries), undefined);
            }
        });

        it('allows more-specific ports despite a conflict at :*', () => {
            const certificates = {
                'foo.com:*': { cert: 'a.crt' }, 'FOO.COM:*': { cert: 'b.crt' },
                'foo.com': { cert: 'no-port.crt' }, 'foo.com:8443': { cert: 'port.crt' }
            };
            assert.strictEqual(findHostCertificate('https://foo.com/', certificates)?.value.cert, 'no-port.crt');
            assert.strictEqual(findHostCertificate('https://foo.com:8443/', certificates)?.value.cert, 'port.crt');
            assert.throws(() => findHostCertificate('https://foo.com:9000/', certificates), HostCertificateConflictError);
        });
    });

    describe('invalid wildcard keys', () => {
        const invalid = [
            'foo*.example.com', 'a.*.example.com', '*example.com', '*', '**', '*.',
            '*.example.com:abc', '*.example.com:', '***.example.com', 'https://*.example.com',
            '*.example.com/path', '**.example.com?query', '*.example.com#fragment',
            '*.example..com', '*..example.com', '*.example.com.', '*.example.com:*:8443'
        ];
        it('ignores and reports invalid keys without affecting valid ones', () => {
            const certificates = Object.fromEntries(invalid.map(key => [key, {}]));
            const reported: string[] = [];
            assert.strictEqual(findHostCertificate('https://a.example.com/', certificates, key => reported.push(key)), undefined);
            assert.deepStrictEqual(reported, invalid);
            assert.strictEqual(match('https://a.example.com/', [...invalid, '*.example.com']), '*.example.com');
        });

        it('does not validate keys without *', () => {
            const reported: string[] = [];
            findHostCertificate('https://a.example.com/', {
                'foo.com': {}, '[::1]:8443': {}, 'my_host': {}, 'https://foo.com': {}, 'foo.com/path': {}
            }, key => reported.push(key));
            assert.deepStrictEqual(reported, []);
        });

        it('keeps the settings schema aligned with runtime validation', () => {
            const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
            const pattern = manifest.contributes.configuration.properties['rest-client.certificates'].propertyNames.pattern;
            assert.strictEqual(pattern, HOST_CERTIFICATE_KEY_PATTERN);
            const schema = new RegExp(pattern);
            for (const key of invalid) {
                assert.strictEqual(schema.test(key), false, key);
            }
            for (const key of ['Foo.COM', 'my_host', '[::1]:8443', '[::1]:*', '*.EXAMPLE.com:443', '**.example.com:*', 'foo.com:*']) {
                assert.strictEqual(schema.test(key), true, key);
            }
        });
    });

    it('returns no match for empty settings or a URL without a host', () => {
        assert.strictEqual(findHostCertificate('https://foo.com/', {}), undefined);
        assert.strictEqual(findHostCertificate('not a url', { 'foo.com': {} }), undefined);
    });

    it('returns the configured value unchanged', () => {
        const value = { cert: 'client.crt', key: 'client.key' };
        const result = findHostCertificate('https://a.example.com/', { '*.example.com': value });
        assert.deepStrictEqual(result, { key: '*.example.com', value });
        assert.strictEqual(result?.value, value);
    });
});
