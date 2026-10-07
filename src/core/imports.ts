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
    read: (f: string) => string = (f) => fs.readFileSync(f, 'utf8')
): { imported: Imported[]; missing: string[] } {
    const root = path.resolve(file);
    const seen = new Set<string>([root]);
    const queue = importedPaths(text ?? read(root), root);
    const imported: Imported[] = [];
    const missing: string[] = [];
    while (queue.length) {
        const f = queue.shift()!;
        if (seen.has(f)) {
            continue;
        }
        seen.add(f);
        if (!fs.existsSync(f)) {
            missing.push(f);
            continue;
        }
        const t = read(f);
        imported.push({ file: f, text: t });
        queue.push(...importedPaths(t, f));
    }
    return { imported, missing };
}

/** The block whose `@name` matches: first in the text itself, then in the imports, in order. */
export function namedBlock(name: string, text: string, imported: Imported[]): (Block & { file?: string }) | undefined {
    const own = splitBlocks(text).find(b => b.name === name);
    if (own) {
        return own;
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
        throw new Error(`run #${m[1]}: no request with that name in this file or the ones it imports`);
    }
    return { ...real, line: block.line };
}

/** The `@variable = value` pairs of a text, in order of appearance; the last definition wins. */
export function textVariables(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of text.matchAll(/^\s*@([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/gm)) {
        out[m[1]] = m[2];
    }
    return out;
}

/** Variables from the imports, in order, with the file's own on top. */
export function variablesWithImports(text: string, imported: Imported[]): Record<string, string> {
    let out: Record<string, string> = {};
    for (const i of imported) {
        out = { ...out, ...textVariables(i.text) };
    }
    return { ...out, ...textVariables(text) };
}
