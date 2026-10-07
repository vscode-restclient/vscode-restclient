import * as path from 'path';

/**
 * The only thing the core needs from the outside world.
 *
 * In VS Code the extension implements it; in the terminal, the runner. The
 * parser and the HTTP client are already pure code, so with this the same
 * `.http` file runs in the editor and on a continuous integration server.
 */
export interface EnvironmentData {
    /** Warnings for the user: a dialog in the editor, a line on stderr outside it. */
    warn(message: string): void;
    /** Root that relative paths are resolved against. */
    root(): string | undefined;
    /** The .http file in play, if any: the last resort for relative paths. */
    currentFile(): string | undefined;
}

/** Terminal environment: warnings go to stderr so they do not pollute the output. */
export function terminalEnvironment(root: string, currentFile?: string): EnvironmentData {
    return {
        warn: (message: string) => process.stderr.write(`warning: ${message}\n`),
        root: () => path.resolve(root),
        currentFile: () => currentFile
    };
}
