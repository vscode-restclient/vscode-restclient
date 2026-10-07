// Elige un fotograma por plano, recorta la barra de titulo y monta el GIF.
//
// El fotograma se toma un segundo DESPUES de la senal, no al final del tramo:
// el ultimo fotograma de un plano ya suele tener encima lo que hace el guion
// para preparar el siguiente.
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEMO = path.join(RAIZ, 'media', 'demo');
const SHOTS = path.join(RAIZ, 'media', 'shots');
const FPS = 5;
const REPOSO = 5;          // fotogramas a esperar tras la senal
const RECORTE_ARRIBA = 34; // la barra de titulo delata el "Extension Development Host"

const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';

const index = fs.readFileSync(path.join(DEMO, 'indice.csv'), 'utf8')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { const [n, plano] = l.split(','); return { n: Number(n), plano }; });

const primeros = new Map();
for (const { n, plano } of index) if (!primeros.has(plano)) primeros.set(plano, n);

fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const correr = (args) => {
    const r = cp.spawnSync(ffmpeg, args, { encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stderr?.slice(-1500)); throw new Error('ffmpeg fallo'); }
};

// El plano del stream se toma más tarde: a los 5 fotogramas aún no ha llegado
// nada; a los 12 (2,4 s) hay tres o cuatro eventos en pantalla.
const REPOSO_POR_PLANO = { '05-stream': 12 };
for (const [plano, primero] of primeros) {
    const n = primero + (REPOSO_POR_PLANO[plano] ?? REPOSO);
    const origen = path.join(DEMO, `f${String(n).padStart(5, '0')}.png`);
    if (!fs.existsSync(origen)) { console.error(`falta ${origen}`); continue; }
    const destino = path.join(SHOTS, `${plano}.png`);
    correr(['-y', '-loglevel', 'error', '-i', origen, '-vf', `crop=iw:ih-${RECORTE_ARRIBA}:0:${RECORTE_ARRIBA}`, destino]);
    console.log(`${plano} <- fotograma ${n} (${(fs.statSync(destino).size / 1024).toFixed(0)} KB)`);
}

// El GIF arranca en el primer plano: los segundos de VS Code abriendo no
// aportan nada y engordan el fichero.
const arranque = Math.min(...primeros.values());
const gif = path.join(SHOTS, 'demo.gif');
correr([
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS),
    '-start_number', String(arranque),
    '-i', path.join(DEMO, 'f%05d.png'),
    '-vf', `crop=iw:ih-${RECORTE_ARRIBA}:0:${RECORTE_ARRIBA},scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer`,
    gif,
]);
console.log(`demo.gif ${(fs.statSync(gif).size / 1024 / 1024).toFixed(2)} MB`);
