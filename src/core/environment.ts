import * as path from 'path';

/**
 * Lo único que el núcleo necesita del mundo exterior.
 *
 * En VS Code lo implementa la extensión; en la terminal, el runner. El parser
 * y el cliente HTTP ya son código puro, así que con esto el mismo fichero
 * `.http` se ejecuta en el editor y en un servidor de integración continua.
 */
export interface EnvironmentData {
    /** Avisos al usuario: un diálogo en el editor, una línea en stderr fuera. */
    warn(message: string): void;
    /** Raíz desde la que se resuelven las rutas relativas. */
    root(): string | undefined;
    /** Fichero .http en curso, si lo hay: último recurso para rutas relativas. */
    currentFile(): string | undefined;
}

/** Entorno de terminal: los avisos van a stderr para no ensuciar la salida. */
export function terminalEnvironment(root: string, currentFile?: string): EnvironmentData {
    return {
        warn: (message: string) => process.stderr.write(`aviso: ${message}\n`),
        root: () => path.resolve(root),
        currentFile: () => currentFile
    };
}
