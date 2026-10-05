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
    const anyRoot = root ?? workspace.workspaceFolders?.[0]?.uri.fsPath;
    const begin = doc && doc.uri.scheme === 'file' ? path.dirname(doc.fileName) : anyRoot;
    if (!begin) {
        return undefined;
    }
    return environmentsFolder(begin, anyRoot);
}

/** The file environments a document sees (`{}` if there are no files). */
export function fileEnvironments(document?: TextDocument): Environments {
    const folder = environmentsFolderOf(document);
    return folder ? readEnvironments(folder, warnOnce) : {};
}

// Broken JSON is hit on every variable of every request: warning each time
// would be a shower of warnings for a single typo.
let lastWarning = '';
let lastWarningAt = 0;
function warnOnce(message: string) {
    const now = Date.now();
    if (message === lastWarning && now - lastWarningAt < 30_000) {
        return;
    }
    lastWarning = message;
    lastWarningAt = now;
    window.showWarningMessage(l10n.t('Environment file: {0}', message));
}
