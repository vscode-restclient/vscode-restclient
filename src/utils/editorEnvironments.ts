import * as path from 'path';
import { l10n, TextDocument, window, workspace } from 'vscode';
import { environmentsFolder, Environments, readEnvironments } from '../core/jetBrainsEnvironments';
import { getCurrentTextDocument } from './workspaceUtility';

/**
 * Where the `http-client.env.json` files that apply to a document live: from
 * its folder upwards, without leaving the workspace. An unsaved document looks
 * from the workspace root.
 */
export function environmentsFolderOf(document?: TextDocument): string | undefined {
    const doc = document ?? getCurrentTextDocument();
    const root = doc ? workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath : undefined;
    const raizCualquiera = root ?? workspace.workspaceFolders?.[0]?.uri.fsPath;
    const inicio = doc && doc.uri.scheme === 'file' ? path.dirname(doc.fileName) : raizCualquiera;
    if (!inicio) {
        return undefined;
    }
    return environmentsFolder(inicio, raizCualquiera);
}

/** The file environments a document sees (`{}` if there are no files). */
export function fileEnvironments(document?: TextDocument): Environments {
    const folder = environmentsFolderOf(document);
    return folder ? readEnvironments(folder, warnOnce) : {};
}

// Broken JSON is hit on every variable of every request: warning each time
// would be a shower of warnings for a single typo.
let ultimoAviso = '';
let ultimoAvisoEn = 0;
function warnOnce(message: string) {
    const ahora = Date.now();
    if (message === ultimoAviso && ahora - ultimoAvisoEn < 30_000) {
        return;
    }
    ultimoAviso = message;
    ultimoAvisoEn = ahora;
    window.showWarningMessage(l10n.t('Environment file: {0}', message));
}
