import * as path from 'path';
import { ExtensionContext, Uri, window, workspace } from 'vscode';
import { DataLocation, dataLocationOf, DataPaths, folderDataPaths, homeDataPaths, isHomeFolder, workspaceDataPaths } from '../core/dataLocation';
import { UserDataManager } from './userDataManager';

/** `rest-client.dataLocation`, read every time so a change applies at once. */
export function dataLocation(): DataLocation {
    return dataLocationOf(workspace.getConfiguration('rest-client').get('dataLocation'));
}

/** The last document a request went out from: see projectFolder. */
let lastDocument: string | undefined;

/** Called for each request sent from the editor. */
export function rememberDocument(documentUri: string | undefined): void {
    if (documentUri) {
        lastDocument = documentUri;
    }
}

/**
 * Points UserDataManager at the folders the setting asks for.
 * `onProjectFolder` hears of each workspace folder whose `.rest-client/` has
 * just been created, so the selection can be left there for the runner.
 */
export function installDataLocator(context: ExtensionContext, onProjectFolder: (workspaceFolder: string) => void): void {
    const shared = context.globalStorageUri.fsPath;
    UserDataManager.configure(
        documentUri => locate(documentUri, shared),
        paths => onProjectFolder(path.dirname(paths.cache)));
}

function locate(documentUri: string | undefined, shared: string): DataPaths {
    switch (dataLocation()) {
        case 'shared':
            return folderDataPaths(shared);
        case 'workspace': {
            // A file outside every workspace folder has no project: home.
            const folder = documentUri ? workspaceFolderOf(documentUri) : projectFolder();
            return folder ? workspaceDataPaths(folder) : homeDataPaths();
        }
        default:
            return homeDataPaths();
    }
}

/** The workspace folder on disk holding the document; never the home folder (see isHomeFolder). */
function workspaceFolderOf(documentUri: string): string | undefined {
    const folder = workspace.getWorkspaceFolder(Uri.parse(documentUri));
    return folder?.uri.scheme === 'file' && !isHomeFolder(folder.uri.fsPath) ? folder.uri.fsPath : undefined;
}

/**
 * For the commands that act on no particular request (history, clear
 * cookies): the project of the editor in front, when it is a file of the
 * workspace; otherwise (a response, an untitled document, the focus on the
 * response panel) the project of the last request sent.
 */
function projectFolder(): string | undefined {
    const active = window.activeTextEditor?.document.uri;
    const fromActive = active ? workspaceFolderOf(active.toString()) : undefined;
    return fromActive ?? (lastDocument ? workspaceFolderOf(lastDocument) : undefined);
}

/** The workspace folders on disk, where `workspace` mode leaves the selection for the runner; never the home folder. */
export function localFolders(): string[] {
    return (workspace.workspaceFolders ?? [])
        .filter(f => f.uri.scheme === 'file' && !isHomeFolder(f.uri.fsPath))
        .map(f => f.uri.fsPath);
}
