import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveRelativePath } from '../../core/environment';

describe('resolveRelativePath', () => {
    let dir: string;
    let root: string;
    let httpDir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restclient-'));
        root = path.join(dir, 'ws');
        httpDir = path.join(root, 'api');
        fs.mkdirSync(httpDir, { recursive: true });
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const env = (r: string | undefined, file: string | undefined) => ({ root: () => r, currentFile: () => file });

    it('finds a path relative to the root', () => {
        fs.writeFileSync(path.join(root, 'a.pem'), '');
        assert.strictEqual(resolveRelativePath('a.pem', env(root, path.join(httpDir, 'x.http'))), path.join(root, 'a.pem'));
    });

    it('falls back to the directory of the http file when the root has no match', () => {
        fs.writeFileSync(path.join(httpDir, 'b.pem'), '');
        assert.strictEqual(resolveRelativePath('./b.pem', env(root, path.join(httpDir, 'x.http'))), path.join(httpDir, 'b.pem'));
    });

    it('prefers the root when both match', () => {
        fs.writeFileSync(path.join(root, 'c.pem'), '');
        fs.writeFileSync(path.join(httpDir, 'c.pem'), '');
        assert.strictEqual(resolveRelativePath('c.pem', env(root, path.join(httpDir, 'x.http'))), path.join(root, 'c.pem'));
    });

    it('works without a root', () => {
        fs.writeFileSync(path.join(httpDir, 'd.pem'), '');
        assert.strictEqual(resolveRelativePath('d.pem', env(undefined, path.join(httpDir, 'x.http'))), path.join(httpDir, 'd.pem'));
    });

    it('returns undefined when nothing matches', () => {
        assert.strictEqual(resolveRelativePath('missing.pem', env(root, path.join(httpDir, 'x.http'))), undefined);
        assert.strictEqual(resolveRelativePath('missing.pem', env(undefined, undefined)), undefined);
    });
});
