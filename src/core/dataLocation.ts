// Where the extension keeps history, cookies and saved responses, and where
// the selected environment is left for the terminal runner to find. Shared by
// the editor and the runner, so both look in the same places. No `vscode`.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * `home`: `~/.rest-client` (or `VSC_REST_CLIENT_HOME`), as REST Client always
 * did. `workspace`: a `.rest-client/` folder in the workspace folder of the
 * `.http` file. `shared`: the folder VS Code gives the extension
 * (`globalStorageUri`), outside the home folder.
 */
export type DataLocation = 'home' | 'workspace' | 'shared';

export const DATA_LOCATIONS: readonly DataLocation[] = ['home', 'workspace', 'shared'];

/** The folder `workspace` mode creates inside each workspace folder. */
export const WORKSPACE_DATA_FOLDER = '.rest-client';

/** The editor's selection, as `{ "name": …, "label": … }`. */
export const SELECTION_FILE = 'environment.json';

/** The name the editor stores for «no environment». */
export const NO_ENVIRONMENT = 'c0cfe680-4fcd-4b71-a4ba-8cfaee57680a';

const GITIGNORE_HEADER = '# REST Client CE: history, cookies and saved responses of this project.';

const GITIGNORE = [
    GITIGNORE_HEADER,
    '# They can hold tokens and session cookies: never commit them.',
    '*',
    ''
].join('\n');

export interface DataPaths {
    /** History, cookies and saved responses. */
    cache: string;
    /** The selected environment of the old shared file. */
    state: string;
    /** A folder inside a project: it gets its own `.gitignore` when created. */
    insideProject?: boolean;
}

/** An unknown or missing value is `home`: nobody loses their data to a typo. */
export function dataLocationOf(value: unknown): DataLocation {
    return DATA_LOCATIONS.includes(value as DataLocation) ? value as DataLocation : 'home';
}

/**
 * `~/.rest-client`, or `VSC_REST_CLIENT_HOME`, the variable REST Client
 * documented. When that folder does not exist yet, the XDG folders are used
 * if they are set, which is what the original extension did.
 */
export function homeDataPaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): DataPaths {
    const root = env.VSC_REST_CLIENT_HOME ?? path.join(home, '.rest-client');
    if (fs.existsSync(root)) {
        return { cache: root, state: root };
    }
    return {
        cache: env.XDG_CACHE_HOME !== undefined ? path.join(env.XDG_CACHE_HOME, 'rest-client') : root,
        state: env.XDG_STATE_HOME !== undefined ? path.join(env.XDG_STATE_HOME, 'rest-client') : root
    };
}

/** The same folder for everything: `shared` mode. */
export function folderDataPaths(folder: string): DataPaths {
    return { cache: folder, state: folder };
}

/** `<workspace folder>/.rest-client`: `workspace` mode. */
export function workspaceDataPaths(workspaceFolder: string): DataPaths {
    const folder = path.join(workspaceFolder, WORKSPACE_DATA_FOLDER);
    return { cache: folder, state: folder, insideProject: true };
}

/**
 * The same folder, with the case ignored where the file system ignores it by
 * default (Windows, macOS): `C:\proj` and `c:\PROJ` are one.
 */
export function samePath(a: string, b: string): boolean {
    const x = path.resolve(a);
    const y = path.resolve(b);
    return process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * True when `<workspace folder>/.rest-client/` was created by this extension
 * (it holds the `.gitignore` it writes). A `.rest-client/` a repository keeps
 * for something else is not written to unless the user asks.
 */
export function hasOwnDataFolder(workspaceFolder: string): boolean {
    try {
        const ignore = path.join(workspaceDataPaths(workspaceFolder).cache, '.gitignore');
        return fs.readFileSync(ignore, 'utf8').startsWith(GITIGNORE_HEADER);
    } catch {
        return false;
    }
}

/**
 * The home folder opened as a workspace folder. Its `.rest-client` is the
 * home one, the one `home` mode uses and REST Client shared between windows,
 * so `workspace` mode treats it as no project at all.
 */
export function isHomeFolder(folder: string, home: string = os.homedir()): boolean {
    return samePath(folder, home);
}

/**
 * Creates `folder` if needed. A folder inside a project also gets a
 * `.gitignore` that ignores everything in it, itself included, the first time:
 * an existing one is never overwritten. True when the folder was created now.
 */
export function prepareFolder(folder: string, insideProject = false): boolean {
    const created = !fs.existsSync(folder);
    fs.mkdirSync(folder, { recursive: true });
    if (insideProject) {
        const ignore = path.join(folder, '.gitignore');
        if (!fs.existsSync(ignore)) {
            fs.writeFileSync(ignore, GITIGNORE);
        }
    }
    return created;
}

/**
 * Marks the selection files written for the runner. `~/.rest-client` holds a
 * file with the same name, the selection REST Client shared between windows,
 * and a project under the home folder must not inherit it.
 */
const FOR_THE_RUNNER = 'workspace';

function selectionFile(workspaceFolder: string): string {
    return path.join(workspaceDataPaths(workspaceFolder).state, SELECTION_FILE);
}

function readMarked(file: string): { name?: unknown } | undefined {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return json && json.scope === FOR_THE_RUNNER ? json : undefined;
}

/**
 * Writes the editor's selection into `<workspace folder>/.rest-client/environment.json`.
 * Never into the home folder: see isHomeFolder.
 */
export function writeSelection(workspaceFolder: string, selection: { name: string; label: string }, home: string = os.homedir()): void {
    if (isHomeFolder(workspaceFolder, home)) {
        return;
    }
    const { state, insideProject } = workspaceDataPaths(workspaceFolder);
    prepareFolder(state, insideProject);
    fs.writeFileSync(selectionFile(workspaceFolder), JSON.stringify({ name: selection.name, label: selection.label, scope: FOR_THE_RUNNER }));
}

/**
 * Removes the selection `writeSelection` left, when the editor stops running
 * in `workspace` mode: a selection the editor no longer keeps up to date must
 * not steer the runner. It is a pointer, not data: history, cookies and
 * saved responses stay. A file without the mark is not ours and stays too.
 */
export function withdrawSelection(workspaceFolder: string, home: string = os.homedir()): void {
    if (isHomeFolder(workspaceFolder, home)) {
        return;
    }
    const file = selectionFile(workspaceFolder);
    try {
        if (fs.existsSync(file) && readMarked(file)) {
            fs.rmSync(file, { force: true });
        }
    } catch {
        // Unreadable: not provably ours, so it stays.
    }
}

/**
 * The environment selected in the editor for the project of `start`: the
 * first `.rest-client/environment.json` written by `writeSelection` found
 * walking up from `start` (not above `ceiling`); any other file of that name
 * is passed over, and so is the home folder's `.rest-client`, which sits
 * above every project in it. `name` is undefined when the editor has «no
 * environment» selected, which also stops the search; the result is
 * undefined when there is no such file, or it cannot be read, which is the
 * case unless the editor runs in `workspace` mode.
 */
export function editorSelection(start: string, ceiling?: string, home: string = os.homedir()): { name?: string; file: string } | undefined {
    let dir = path.resolve(start);
    for (;;) {
        const file = path.join(dir, WORKSPACE_DATA_FOLDER, SELECTION_FILE);
        if (!isHomeFolder(dir, home) && fs.existsSync(file)) {
            let json: { name?: unknown } | undefined;
            try {
                json = readMarked(file);
            } catch {
                return undefined;
            }
            if (json) {
                const name = typeof json.name === 'string' && json.name !== NO_ENVIRONMENT && json.name !== '' ? json.name : undefined;
                return { name, file };
            }
        }
        const parent = path.dirname(dir);
        if ((ceiling && samePath(dir, ceiling)) || parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}

