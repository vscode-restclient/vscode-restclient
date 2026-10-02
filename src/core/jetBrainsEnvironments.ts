/**
 * Ficheros de entorno del formato JetBrains: `http-client.env.json` y
 * `http-client.private.env.json`.
 *
 * Es la familia de peticiones más votada del proyecto original (#229, #627:
 * +83 votos): entornos que viven en el repositorio, junto a los ficheros
 * `.http`, en vez de en los ajustes del editor. El privado va en `.gitignore`
 * y manda sobre el público, así que el equipo comparte el público y cada uno
 * pone sus claves en el privado.
 *
 * Sin `vscode`: lo usan el editor y el runner.
 */
import * as fs from 'fs';
import * as path from 'path';

export const PUBLIC_FILE = 'http-client.env.json';
export const PRIVATE_FILE = 'http-client.private.env.json';

export type Environments = Record<string, Record<string, string>>;

/**
 * Sube carpeta a carpeta desde `desde` y devuelve la primera que tenga alguno
 * de los dos ficheros. `tope` (la raíz del espacio de trabajo, normalmente)
 * frena la búsqueda: más arriba no es del proyecto.
 */
export function environmentsFolder(desde: string, tope?: string): string | undefined {
    let dir = path.resolve(desde);
    const limit = tope ? path.resolve(tope) : undefined;
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
 * Público + privado, el privado encima. Un JSON roto no tumba nada: se avisa
 * y se sigue con lo que haya, que es lo que uno quiere mientras edita el
 * fichero.
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

/** Un valor que no sea texto (número, objeto) se usa tal cual se escribiría en la petición. */
const aTexto = (o: Record<string, unknown>): Record<string, string> =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
