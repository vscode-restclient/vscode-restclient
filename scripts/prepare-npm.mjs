// Deja npm/ listo para `npm publish`: copia el bundle del runner, la licencia
// y sincroniza la versión con la de la extensión. Publicar es cosa del humano
// (npm exige sesión interactiva); esto sólo prepara.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(RAIZ, 'dist', 'cli.js');
if (!fs.existsSync(bundle)) {
    console.error('falta dist/cli.js: ejecuta npm run build antes');
    process.exit(1);
}
const version = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).version;
const pkgRuta = path.join(RAIZ, 'npm', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgRuta, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgRuta, JSON.stringify(pkg, null, 2) + '\n');
fs.copyFileSync(bundle, path.join(RAIZ, 'npm', 'cli.js'));
fs.copyFileSync(path.join(RAIZ, 'LICENSE'), path.join(RAIZ, 'npm', 'LICENSE'));
console.log(`npm/ listo: ${pkg.name}@${version} (${(fs.statSync(bundle).size / 1024).toFixed(0)} KB). Publicar: cd npm && npm publish --access public`);
