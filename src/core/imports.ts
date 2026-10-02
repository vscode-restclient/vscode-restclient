/**
 * `import ./comun.http` y `run #nombre`, como en JetBrains.
 *
 * Es la otra mitad de la familia más votada del original (#182 +52, #845 +29,
 * #1148 +23, #943 +22, #402 +26): variables y peticiones compartidas entre
 * ficheros. Un fichero importa a otro; con eso hereda sus `@variables` y puede
 * ejecutar sus peticiones con nombre.
 *
 * Sin `vscode`: lo usan el editor y el runner.
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

/** Rutas de `import` de un texto, resueltas contra la carpeta del fichero que las contiene. */
export function importedPaths(text: string, ficheroBase: string): string[] {
    const dir = path.dirname(path.resolve(ficheroBase));
    return [...text.matchAll(IMPORT)].map(m => path.resolve(dir, m[1] ?? m[2] ?? m[3]));
}

/**
 * Todos los ficheros importados, en orden de aparición y sin repetir: un
 * fichero que se importa a sí mismo, o dos que se importan mutuamente, se leen
 * una sola vez. Los que no existen se saltan y se devuelven aparte para poder
 * avisar.
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

/** Bloque con `@name` = nombre: primero en el propio texto, luego en los importados, en orden. */
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
 * Si el bloque es `run #x`, devuelve el bloque real (con su `@name`, para que
 * la respuesta se guarde con ese nombre); si no, el mismo bloque. Conserva la
 * línea del `run` para que los errores señalen donde está escrito.
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

/** `@variable = valor` de un texto, en orden de aparición (la última definición gana). */
export function textVariables(text: string): Record<string, string> {
    const fuera: Record<string, string> = {};
    for (const m of text.matchAll(/^\s*@([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/gm)) {
        fuera[m[1]] = m[2];
    }
    return fuera;
}

/** Variables de los importados (en orden) con las propias encima. */
export function variablesWithImports(text: string, imported: Imported[]): Record<string, string> {
    let fuera: Record<string, string> = {};
    for (const i of imported) {
        fuera = { ...fuera, ...textVariables(i.text) };
    }
    return { ...fuera, ...textVariables(text) };
}
