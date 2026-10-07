// Gets npm/ ready for `npm publish`: copies the runner bundle and the license
// and syncs the version with the extension's. Publishing is for a human (npm
// wants an interactive session); this only prepares.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(ROOT, 'dist', 'cli.js');
if (!fs.existsSync(bundle)) {
    console.error('dist/cli.js is missing: run npm run build first');
    process.exit(1);
}
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const pkgPath = path.join(ROOT, 'npm', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
fs.copyFileSync(bundle, path.join(ROOT, 'npm', 'cli.js'));
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(ROOT, 'npm', 'LICENSE'));
console.log(`npm/ ready: ${pkg.name}@${version} (${(fs.statSync(bundle).size / 1024).toFixed(0)} KB). Publish with: cd npm && npm publish --access public`);
