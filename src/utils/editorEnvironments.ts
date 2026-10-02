import * as path from 'path';
import { l10n, TextDocument, window, workspace } from 'vscode';
import { environmentsFolder, Environments, readEnvironments } from '../core/jetBrainsEnvironments';
import { getCurrentTextDocument } from './workspaceUtility';

/**
 * Dónde están los `http-client.env.json` que le tocan a un documento: desde su
 * carpeta hacia arriba, sin salir del espacio de trabajo. Un documento sin
 * guardar mira desde la raíz del espacio de trabajo.
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

/** Entornos de fichero que ve un documento (`{}` si no hay ficheros). */
export function fileEnvironments(document?: TextDocument): Environments {
    const folder = environmentsFolderOf(document);
    return folder ? readEnvironments(folder, warnOnce) : {};
}

// Un JSON roto se resuelve en cada variable de cada petición: avisar cada vez
// sería una lluvia de avisos por un solo error de escritura.
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
