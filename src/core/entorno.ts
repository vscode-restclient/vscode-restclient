import * as path from 'path';

/**
 * Lo único que el núcleo necesita del mundo exterior.
 *
 * En VS Code lo implementa la extensión; en la terminal, el runner. El parser
 * y el cliente HTTP ya son código puro, así que con esto el mismo fichero
 * `.http` se ejecuta en el editor y en un servidor de integración continua.
 */
export interface Entorno {
    /** Avisos al usuario: un diálogo en el editor, una línea en stderr fuera. */
    avisar(mensaje: string): void;
    /** Output-only warnings, without an editor notification. */
    logWarning?(message: string): void;
    /** Raíz desde la que se resuelven las rutas relativas. */
    raiz(): string | undefined;
    /** Fichero .http en curso, si lo hay: último recurso para rutas relativas. */
    ficheroActual(): string | undefined;
}

/** Entorno de terminal: los avisos van a stderr para no ensuciar la salida. */
export function entornoTerminal(raiz: string, ficheroActual?: string): Entorno {
    return {
        avisar: (mensaje: string) => process.stderr.write(`aviso: ${mensaje}\n`),
        logWarning: (message: string) => process.stderr.write(`warning: ${message}\n`),
        raiz: () => path.resolve(raiz),
        ficheroActual: () => ficheroActual
    };
}
