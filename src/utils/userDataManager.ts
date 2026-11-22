import * as fs from 'fs-extra';
import * as path from 'path';
import { DataPaths, homeDataPaths, prepareFolder, SELECTION_FILE } from '../core/dataLocation';
import { HistoricalHttpRequest } from '../models/httpRequest';
import { JsonFileUtility } from './jsonFileUtility';

/**
 * Where the data of a document lives. The extension installs one that reads
 * `rest-client.dataLocation`; until then, and outside VS Code, it is the home
 * folder. `documentUri` is the `.http` file the data belongs to; without one
 * the extension uses the active editor.
 */
export type DataLocator = (documentUri?: string) => DataPaths;

// The home folder keeps REST Client's name on purpose: whoever comes from
// there finds their history and their cookies where they left them.
// VSC_REST_CLIENT_HOME, the variable that extension documented, is honoured
// for the same reason (see homeDataPaths).
export class UserDataManager {

    private static readonly historyItemsMaxCount = 50;

    private static locate: DataLocator = () => homeDataPaths();

    private static onProjectFolder?: (paths: DataPaths) => void;

    /** `onProjectFolder` hears of each folder inside a project created to hold data. */
    public static configure(locate: DataLocator, onProjectFolder?: (paths: DataPaths) => void): void {
        this.locate = locate;
        this.onProjectFolder = onProjectFolder;
    }

    /** The folders for `documentUri`, created (with their `.gitignore` inside a project) so they can be written. */
    private static prepared(documentUri?: string): DataPaths {
        const paths = this.locate(documentUri);
        if (prepareFolder(paths.cache, paths.insideProject) && paths.insideProject) {
            this.onProjectFolder?.(paths);
        }
        return paths;
    }

    public static cookieFilePath(documentUri?: string): string {
        return path.join(this.prepared(documentUri).cache, 'cookie.json');
    }

    private static historyFilePath(documentUri?: string): string {
        return path.join(this.locate(documentUri).cache, 'history.json');
    }

    public static async addToRequestHistory(request: HistoricalHttpRequest, documentUri?: string) {
        const file = path.join(this.prepared(documentUri).cache, 'history.json');
        const requests = await JsonFileUtility.deserializeFromFile<HistoricalHttpRequest[]>(file, []);
        requests.unshift(request);
        await JsonFileUtility.serializeToFile(file, requests.slice(0, this.historyItemsMaxCount));
    }

    public static async clearRequestHistory(documentUri?: string): Promise<void> {
        const file = this.historyFilePath(documentUri);
        if (await fs.pathExists(file)) {
            await JsonFileUtility.serializeToFile(file, []);
        }
    }

    public static getRequestHistory(documentUri?: string): Promise<HistoricalHttpRequest[]> {
        return JsonFileUtility.deserializeFromFile(this.historyFilePath(documentUri), []);
    }

    /**
     * The selection REST Client kept in `~/.rest-client/environment.json`,
     * shared by every window. Read once, for a workspace that has none of its
     * own yet; never written any more.
     */
    public static getLegacyEnvironment(): Promise<unknown> {
        return JsonFileUtility.deserializeFromFile(path.join(homeDataPaths().state, SELECTION_FILE));
    }

    public static getResponseSaveFilePath(fileName: string, documentUri?: string) {
        const folder = path.join(this.prepared(documentUri).cache, 'responses', 'raw');
        fs.ensureDirSync(folder);
        return path.join(folder, fileName);
    }

    public static getResponseBodySaveFilePath(fileName: string, documentUri?: string) {
        const folder = path.join(this.prepared(documentUri).cache, 'responses', 'body');
        fs.ensureDirSync(folder);
        return path.join(folder, fileName);
    }
}
