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

// The capturer copies the window rectangle; now and then it lands between two
// repaints and the frame comes out black. Those frames are a fraction of the
// size of a real one: they are skipped for the shots and left out of the GIF.
const frameFile = (n) => path.join(DEMO, `f${String(n).padStart(5, '0')}.png`);
const frameNumbers = fs.readdirSync(DEMO).map((f) => /^f(\d+)\.png$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
const sizes = frameNumbers.map((n) => fs.statSync(frameFile(n)).size).sort((a, b) => a - b);
const blankBelow = sizes[Math.floor(sizes.length / 2)] * 0.3;
const isBlank = (n) => !fs.existsSync(frameFile(n)) || fs.statSync(frameFile(n)).size < blankBelow;

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
    let n = first + (SETTLE_PER_SHOT[shot] ?? SETTLE);
    // A black frame right there: take the next good one, never more than a second later.
    for (let tries = 0; tries < FPS && isBlank(n) && fs.existsSync(frameFile(n + 1)); tries++) n++;
    const source = frameFile(n);
    if (!fs.existsSync(source)) { console.error(`missing ${source}`); continue; }
    if (isBlank(n)) { console.error(`${shot}: frame ${n} looks blank (${fs.statSync(source).size} bytes)`); process.exitCode = 1; }
    const target = path.join(SHOTS, `${shot}.png`);
    run(['-y', '-loglevel', 'error', '-i', source, '-vf', `crop=iw:ih-${CROP_TOP}:0:${CROP_TOP}`, target]);
    console.log(`${shot} <- frame ${n} (${(fs.statSync(target).size / 1024).toFixed(0)} KB)`);
}

// The GIF starts at the first shot: the seconds of VS Code opening add
// nothing and fatten the file.
const start = Math.min(...firstFrames.values());
const kept = frameNumbers.filter((n) => n >= start && !isBlank(n));
const list = path.join(DEMO, 'frames.txt');
// The concat demuxer ignores the duration of the last entry unless the file is
// listed once more, so the final shot stays on screen as long as the others.
const entry = (n) => `file '${frameFile(n).replace(/\\/g, '/')}'`;
fs.writeFileSync(list, kept.map((n) => `${entry(n)}\nduration ${1 / FPS}`).concat(entry(kept[kept.length - 1])).join('\n') + '\n');
const gif = path.join(SHOTS, 'demo.gif');
run([
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0',
    '-i', list,
    '-vf', `crop=iw:ih-${CROP_TOP}:0:${CROP_TOP},scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer`,
    gif,
]);
console.log(`demo.gif ${(fs.statSync(gif).size / 1024 / 1024).toFixed(2)} MB (${kept.length} frames, ${frameNumbers.filter((n) => n >= start).length - kept.length} blank ones left out)`);
