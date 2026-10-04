/**
 * `import ./common.http` and `run #name`, as in JetBrains.
 *
 * The other half of the most upvoted family in the original (#182 +52, #845
 * +29, #1148 +23, #943 +22, #402 +26): variables and requests shared between
 * files. One file imports another, inheriting its `@variables` and being able
 * to run its named requests.
 *
 * No `vscode` import: both the editor and the runner use this.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Block, splitBlocks } from './sequence';

const IMPORT = /^\s*import\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/gm;
export const IMPORT_LINE = /^\s*import\s+\S/;
export const RUN = /^\s*run\s+#(\S+)\s*$/m;

export interface Imported {
    file: string;
    text: string;
}

/** The `import` paths of a text, resolved against the folder of the file holding them. */
export function importedPaths(text: string, baseFile: string): string[] {
    const dir = path.dirname(path.resolve(baseFile));
    return [...text.matchAll(IMPORT)].map(m => path.resolve(dir, m[1] ?? m[2] ?? m[3]));
}

/**
 * Every imported file, in order of appearance and without repeats: a file that
 * imports itself, or two that import each other, are read once. Missing ones
 * are skipped and returned separately so they can be reported.
 */
export function closeImports(
    file: string,
    text?: string,
    leer: (f: string) => string = (f) => fs.readFileSync(f, 'utf8')
): { imported: Imported[]; faltan: string[] } {
    const root = path.resolve(file);
    const vistos = new Set<string>([root]);
    const cola = importedPaths(text ?? leer(root), root);
    const imported: Imported[] = [];
    const faltan: string[] = [];
    while (cola.length) {
        const f = cola.shift()!;
        if (vistos.has(f)) {
            continue;
        }
        vistos.add(f);
        if (!fs.existsSync(f)) {
            faltan.push(f);
            continue;
        }
        const t = leer(f);
        imported.push({ file: f, text: t });
        cola.push(...importedPaths(t, f));
    }
    return { imported, faltan };
}

/** The block whose `@name` matches: first in the text itself, then in the imports, in order. */
export function namedBlock(name: string, text: string, imported: Imported[]): (Block & { file?: string }) | undefined {
    const propio = splitBlocks(text).find(b => b.name === name);
    if (propio) {
        return propio;
    }
    for (const i of imported) {
        const b = splitBlocks(i.text).find(x => x.name === name);
        if (b) {
            return { ...b, file: i.file };
        }
    }
    return undefined;
}

/**
 * If the block is `run #x`, returns the real block, keeping its `@name` so the
 * response is stored under that name; otherwise the block itself. The line of
 * the `run` is preserved so errors point at where it was written.
 */
export function resolveRun(block: Block, text: string, imported: Imported[]): Block & { file?: string } {
    const m = RUN.exec(block.text);
    if (!m) {
        return block;
    }
    const real = namedBlock(m[1], text, imported);
    if (!real) {
        throw new Error(`run #${m[1]}: no hay ninguna petición con ese nombre en este fichero ni en los importados`);
    }
    return { ...real, line: block.line };
}

/** The `@variable = value` pairs of a text, in order of appearance; the last definition wins. */
export function textVariables(text: string): Record<string, string> {
    const fuera: Record<string, string> = {};
    for (const m of text.matchAll(/^\s*@([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/gm)) {
        fuera[m[1]] = m[2];
    }
    return fuera;
}

/** Variables from the imports, in order, with the file's own on top. */
export function variablesWithImports(text: string, imported: Imported[]): Record<string, string> {
    let fuera: Record<string, string> = {};
    for (const i of imported) {
        fuera = { ...fuera, ...textVariables(i.text) };
    }
    return { ...fuera, ...textVariables(text) };
}
