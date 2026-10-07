// ¿Qué arrastra `vscode` desde un fichero del núcleo?
//
// Sin esto el runner de terminal se rompe al primer descuido: `vscode` sólo
// existe dentro del editor, y un import de más lo tumba al arrancar.
//
// Devuelve TODOS los caminos, no el primero: memorizar por fichero perdía
// aristas y daba luz verde a un núcleo que sí arrastraba el editor.
import fs from 'node:fs';
import path from 'node:path';

const RAIZ = process.argv[2] ?? 'src/cli/index.ts';

/** `import type` desaparece al compilar; `require('vscode')` sólo corre si se llama. */
const importaVscode = (source) => /^\s*import\s(?!type\s)[^;]*from\s+'vscode'/m.test(source);
const sinTipos = (source) => source.replace(/^\s*import\s+type\s[^;]*;\s*$/gm, '');

const culpables = new Map();
const enCurso = new Set();

function buscar(file, camino) {
  const abs = path.resolve(file);
  if (enCurso.has(abs) || !fs.existsSync(abs)) return;
  enCurso.add(abs);

  const source = fs.readFileSync(abs, 'utf8');
  const rel = path.relative('.', abs).split(path.sep).join('/');
  const aqui = [...camino, rel];

  if (importaVscode(source)) {
    if (!culpables.has(rel)) culpables.set(rel, aqui);
  } else {
    for (const m of sinTipos(source).matchAll(/from '(\.[^']+)'/g)) {
      const base = path.resolve(path.dirname(abs), m[1]);
      for (const candidato of [base + '.ts', path.join(base, 'index.ts')]) {
        buscar(candidato, aqui);
      }
    }
  }
  enCurso.delete(abs);
}

buscar(RAIZ, []);

if (culpables.size === 0) {
  console.log(`${RAIZ} no arrastra vscode`);
  process.exit(0);
}
console.log(`${RAIZ} arrastra vscode por ${culpables.size} camino(s):\n`);
for (const [quien, camino] of culpables) {
  console.log(`  ${quien}`);
  console.log(`     ${camino.slice(0, -1).join(' -> ')}\n`);
}
process.exit(1);
