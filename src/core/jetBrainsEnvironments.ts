/**
 * JetBrains-format environment files: `http-client.env.json` and
 * `http-client.private.env.json`.
 *
 * The most upvoted family of requests in the original project (#229, #627:
 * +83 votes): environments that live in the repository, next to the `.http`
 * files, instead of in the editor's settings. The private file goes in
 * `.gitignore` and wins over the public one, so the team shares the public
 * file and everyone keeps their own keys in the private one.
 *
 * No `vscode` import: both the editor and the runner use this.
 */
import * as fs from 'fs';
import * as path from 'path';

export const PUBLIC_FILE = 'http-client.env.json';
export const PRIVATE_FILE = 'http-client.private.env.json';

export type Environments = Record<string, Record<string, string>>;

/**
 * Walks up folder by folder from `start` and returns the first one holding
 * either of the two files. `ceiling` (normally the workspace root) stops the
 * search: anything above it is not part of the project.
 */
export function environmentsFolder(start: string, ceiling?: string): string | undefined {
    let dir = path.resolve(start);
    const limit = ceiling ? path.resolve(ceiling) : undefined;
    for (;;) {
        if (fs.existsSync(path.join(dir, PUBLIC_FILE)) || fs.existsSync(path.join(dir, PRIVATE_FILE))) {
            return dir;
        }
        if (limit && dir === limit) {
            return undefined;
        }
        const padre = path.dirname(dir);
        if (padre === dir) {
            return undefined;
        }
        dir = padre;
    }
}

/**
 * Public plus private, the private one on top. Broken JSON brings nothing
 * down: it warns and carries on with whatever is there, which is what you want
 * while you are still editing the file.
 */
export function readEnvironments(folder: string, warn: (message: string) => void = () => { /* silencio */ }): Environments {
    const fuera: Environments = {};
    for (const name of [PUBLIC_FILE, PRIVATE_FILE]) {
        const filePath = path.join(folder, name);
        if (!fs.existsSync(filePath)) {
            continue;
        }
        try {
            const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (typeof json !== 'object' || json === null) {
                warn(`${name}: se esperaba un objeto con un entorno por clave`);
                continue;
            }
            for (const [environment, vars] of Object.entries(json)) {
                if (typeof vars !== 'object' || vars === null) {
                    continue;
                }
                fuera[environment] = { ...(fuera[environment] ?? {}), ...aTexto(vars as Record<string, unknown>) };
            }
        } catch (e) {
            warn(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return fuera;
}

/** Variables del entorno pedido, o `{}` si no existe. */
export function environmentVariables(folder: string | undefined, environment: string | undefined, warn?: (m: string) => void): Record<string, string> {
    if (!folder || !environment) {
        return {};
    }
    return readEnvironments(folder, warn)[environment] ?? {};
}

/** A value that is not text (a number, an object) is used as it would be written in the request. */
const aTexto = (o: Record<string, unknown>): Record<string, string> =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
