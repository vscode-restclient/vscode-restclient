// Genera THIRD-PARTY-NOTICES.txt a partir del arbol real de produccion.
//
//   node scripts/generar-notices.mjs           reescribe el fichero
//   node scripts/generar-notices.mjs --check   sale 1 si el fichero esta desfasado
//
// Recorre `npm ls --omit=dev --all --json` (lo que de verdad viaja en el
// paquete), y para cada paquete unico copia su fichero de licencia desde
// node_modules. Si un paquete no adjunta el fichero, se deja constancia del
// identificador SPDX que declara: mejor un aviso honesto que un texto
// inventado. La auditoria sigue comprobando aparte que ningun paquete de
// produccion quede sin entrada.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RAIZ = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SALIDA = path.join(RAIZ, 'THIRD-PARTY-NOTICES.txt');
const SEP = '='.repeat(78);

// npm mete avisos en la salida --json (nos tumbo la CI una vez): extraer el objeto.
const json = (salida) => {
  const i = salida.indexOf('{');
  const f = salida.lastIndexOf('}');
  if (i < 0 || f < i) {
    return {};
  }
  try {
    return JSON.parse(salida.slice(i, f + 1));
  } catch {
    return {};
  }
};

let arbolCrudo = '';
try {
  arbolCrudo = execSync('npm ls --omit=dev --all --json', { cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  arbolCrudo = e.stdout ?? '';
}
const arbol = json(arbolCrudo);

const paquetes = new Map(); // "nombre@version" -> nombre
const recorrer = (nodo) => {
  for (const [nombre, v] of Object.entries(nodo?.dependencies ?? {})) {
    if (!v.version) {
      continue; // opcional que npm no instalo: no viaja, no cuenta
    }
    paquetes.set(`${nombre}@${v.version}`, nombre);
    recorrer(v);
  }
};
recorrer(arbol);

// npm anida paquetes cuando conviven dos versiones (p. ej.
// string-width/node_modules/is-fullwidth-code-point): el directorio real de
// cada nombre@version se localiza recorriendo el arbol de disco una vez.
const dirPorClave = new Map();
const escanear = (dirNM) => {
  let hijos = [];
  try {
    hijos = fs.readdirSync(dirNM);
  } catch {
    return;
  }
  for (const hijo of hijos) {
    if (hijo.startsWith('.')) {
      continue;
    }
    const candidatos = hijo.startsWith('@')
      ? (() => { try { return fs.readdirSync(path.join(dirNM, hijo)).map((x) => `${hijo}/${x}`); } catch { return []; } })()
      : [hijo];
    for (const nombre of candidatos) {
      const dir = path.join(dirNM, ...nombre.split('/'));
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (m.name && m.version && !dirPorClave.has(`${m.name}@${m.version}`)) {
          dirPorClave.set(`${m.name}@${m.version}`, dir);
        }
      } catch { /* carpeta sin manifiesto: seguir */ }
      escanear(path.join(dir, 'node_modules'));
    }
  }
};
escanear(path.join(RAIZ, 'node_modules'));

const leerLicencia = (dir) => {
  let ficheros = [];
  try {
    ficheros = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const candidato = ficheros
    .filter((f) => /^(licen[cs]e|copying)(\.|-|$)/i.test(f))
    .sort((a, b) => a.length - b.length)[0];
  return candidato ? fs.readFileSync(path.join(dir, candidato), 'utf8').replace(/\r\n/g, '\n').trim() : null;
};

const entradas = [...paquetes.keys()].sort((a, b) => a.localeCompare(b, 'en')).map((clave) => {
  const nombre = paquetes.get(clave);
  const dir = dirPorClave.get(clave) ?? path.join(RAIZ, 'node_modules', ...nombre.split('/'));
  let manifiesto = {};
  try {
    manifiesto = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch { /* sin manifiesto legible: se emite igualmente la entrada minima */ }
  // Formatos historicos: string, {type}, array de ambos, y el plural `licenses`.
  const normalizar = (v) => Array.isArray(v)
    ? v.map((x) => (typeof x === 'object' ? x?.type : x)).filter(Boolean).join(' OR ')
    : (typeof v === 'object' ? v?.type : v);
  const licencia = normalizar(manifiesto.license) || normalizar(manifiesto.licenses);
  const repo = typeof manifiesto.repository === 'string'
    ? manifiesto.repository
    : manifiesto.repository?.url ?? '';
  const repoLimpio = repo.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://');
  const autor = typeof manifiesto.author === 'string' ? manifiesto.author : manifiesto.author?.name ?? '';

  const lineas = [clave, `License: ${licencia ?? 'unknown'}`];
  if (repoLimpio) {
    lineas.push(`Repository: ${repoLimpio}`);
  }
  if (autor) {
    lineas.push(`Author: ${autor}`);
  }
  const texto = leerLicencia(dir);
  lineas.push('', texto ?? `(The package ships no license file; it declares "${licencia ?? 'unknown'}" in its package.json.)`);
  return lineas.join('\n');
});

const nombreVisible = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).displayName ?? 'REST Client';
const cabecera = [
  `${nombreVisible} — third-party notices`,
  '',
  `${nombreVisible} continues REST Client, Copyright (c) 2016 - present Huachao Mao,`,
  'MIT License (see LICENSE). The packages below are bundled into the extension',
  'and the terminal runner. Each is reproduced with its own license text.',
  '',
  `Generated by scripts/generar-notices.mjs from the production dependency tree`,
  `(${entradas.length} packages). Regenerate with: node scripts/generar-notices.mjs`,
].join('\n');

const contenido = cabecera + '\n\n' + SEP + '\n\n' + entradas.join('\n\n' + SEP + '\n\n') + '\n';

if (process.argv.includes('--check')) {
  const actual = fs.existsSync(SALIDA) ? fs.readFileSync(SALIDA, 'utf8').replace(/\r\n/g, '\n') : '';
  if (actual === contenido) {
    console.log(`THIRD-PARTY-NOTICES.txt al dia (${entradas.length} paquetes).`);
    process.exit(0);
  }
  console.error('THIRD-PARTY-NOTICES.txt esta desfasado: ejecuta `node scripts/generar-notices.mjs` y commitea el resultado.');
  process.exit(1);
}

fs.writeFileSync(SALIDA, contenido);
console.log(`THIRD-PARTY-NOTICES.txt regenerado: ${entradas.length} paquetes.`);
