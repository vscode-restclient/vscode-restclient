// Triaje de los pull requests abiertos del proyecto original.
//
// Sesenta y un parches de desconocidos, algunos de 2020. Leerlos a mano es la
// razón por la que llevan años ahí: esto los ordena por si aún aplican y por
// cuánta gente los pidió, para atacar primero lo que más vale y menos cuesta.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';

const REPO = 'Huachao/vscode-restclient';
const token = execSync('printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill', {
  shell: 'C:/Program Files/Git/bin/bash.exe', encoding: 'utf8'
}).split('\n').find(l => l.startsWith('password='))?.slice(9).trim();

const api = async (ruta) => {
  const r = await fetch(`https://api.github.com/repos/${REPO}${ruta}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' }
  });
  if (!r.ok) throw new Error(`${ruta}: HTTP ${r.status}`);
  return r.json();
};

// Sin shell: los argumentos van como array, asi que nada que venga de la API
// (un numero de PR, un titulo) puede convertirse en una orden.
const correr = (args) => {
  try { return { ok: true, salida: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { ok: false, salida: (e.stdout ?? '') + (e.stderr ?? '') }; }
};

console.log('trayendo los pull requests abiertos...');
const prs = [];
for (let pagina = 1; pagina <= 3; pagina++) {
  const lote = await api(`/pulls?state=open&per_page=100&page=${pagina}`);
  if (!lote.length) break;
  prs.push(...lote);
}
console.log(`${prs.length} abiertos\n`);

const base = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
const filas = [];

for (const pr of prs) {
  const votos = (await api(`/issues/${pr.number}`)).reactions?.total_count ?? 0;
  const ficheros = (await api(`/pulls/${pr.number}/files?per_page=100`)).map(f => f.filename);
  const soloDocs = ficheros.length > 0 && ficheros.every(f => /\.md$|^images\/|^docs\//.test(f));

  // ¿Aplica todavía sobre nuestro main?
  const n = Number(pr.number);
  correr(['fetch', 'origin', `pull/${n}/head:pr-${n}`, '--quiet']);
  const existe = correr(['rev-parse', '--verify', `pr-${n}`]).ok;
  let estado = 'sin rama';
  if (existe) {
    const merge = correr(['merge-tree', '--write-tree', base, `pr-${n}`]);
    estado = merge.ok ? 'aplica' : 'conflicto';
  }

  filas.push({
    n: pr.number,
    titulo: pr.title.replace(/\s+/g, ' ').slice(0, 68),
    autor: pr.user?.login ?? '?',
    fecha: pr.created_at.slice(0, 10),
    votos,
    ficheros: ficheros.length,
    soloDocs,
    estado,
    rutas: ficheros.slice(0, 6)
  });
  process.stdout.write('.');
}
console.log('\n');

const orden = (f) => (f.estado === 'aplica' ? 0 : 1) * 1000 - f.votos;
filas.sort((a, b) => orden(a) - orden(b));

const marca = { aplica: 'APLICA  ', conflicto: 'conflicto', 'sin rama': 'sin rama ' };
console.log('estado     votos  fich  fecha       #     título');
for (const f of filas) {
  console.log(`${marca[f.estado]} ${String(f.votos).padStart(5)} ${String(f.ficheros).padStart(5)}  ${f.fecha}  ${String(f.n).padStart(5)}  ${f.titulo}${f.soloDocs ? '  [solo docs]' : ''}`);
}

const aplican = filas.filter(f => f.estado === 'aplica');
console.log(`\naplican limpio: ${aplican.length} de ${filas.length}`);
console.log(`de esos, con votos: ${aplican.filter(f => f.votos > 0).length}`);
fs.writeFileSync('docs/triaje-prs.json', JSON.stringify(filas, null, 2));
console.log('detalle en docs/triaje-prs.json');
