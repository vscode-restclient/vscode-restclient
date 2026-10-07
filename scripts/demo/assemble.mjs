// Picks one frame per shot, crops the title bar and assembles the GIF.
//
// The frame is taken one second AFTER the signal, not at the end of the
// stretch: the last frame of a shot usually already shows what the script does
// to set up the next one.
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEMO = path.join(ROOT, 'media', 'demo');
const SHOTS = path.join(ROOT, 'media', 'shots');
const FPS = 5;
const SETTLE = 5;          // frames to wait after the signal
const CROP_TOP = 34; // the title bar gives away the "Extension Development Host"

const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';

const index = fs.readFileSync(path.join(DEMO, 'indice.csv'), 'utf8')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { const [n, shot] = l.split(','); return { n: Number(n), shot }; });

const firstFrames = new Map();
for (const { n, shot } of index) if (!firstFrames.has(shot)) firstFrames.set(shot, n);

fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const run = (args) => {
    const r = cp.spawnSync(ffmpeg, args, { encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stderr?.slice(-1500)); throw new Error('ffmpeg failed'); }
};

// The stream shot is taken later: at 5 frames nothing has arrived yet; at 12
// (2.4 s) there are three or four events on screen.
const SETTLE_PER_SHOT = { '05-stream': 12 };
for (const [shot, first] of firstFrames) {
    const n = first + (SETTLE_PER_SHOT[shot] ?? SETTLE);
    const source = path.join(DEMO, `f${String(n).padStart(5, '0')}.png`);
    if (!fs.existsSync(source)) { console.error(`missing ${source}`); continue; }
    const target = path.join(SHOTS, `${shot}.png`);
    run(['-y', '-loglevel', 'error', '-i', source, '-vf', `crop=iw:ih-${CROP_TOP}:0:${CROP_TOP}`, target]);
    console.log(`${shot} <- frame ${n} (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);
}

// The GIF starts at the first shot: the seconds of VS Code opening add
// nothing and fatten the file.
const start = Math.min(...firstFrames.values());
const gif = path.join(SHOTS, 'demo.gif');
run([
    '-y', '-loglevel', 'error',
    '-framerate', String(FPS),
    '-start_number', String(start),
    '-i', path.join(DEMO, 'f%05d.png'),
    '-vf', `crop=iw:ih-${CROP_TOP}:0:${CROP_TOP},scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer`,
    gif,
]);
console.log(`demo.gif ${(fs.statSync(gif).size / 1024 / 1024).toFixed(2)} MB`);
