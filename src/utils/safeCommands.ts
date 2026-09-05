'use strict';
import { commands, Disposable, extensions, l10n, window } from 'vscode';

/*
 * This extension registers the original `rest-client.*` command IDs on purpose:
 * they are public API (keybindings, tasks.json, other extensions calling
 * `executeCommand`). The cost is that installing it side by side with
 * `humao.rest-client` makes both register the same IDs: the second
 * registration throws, and links rendered by one extension can end up
 * handled by the other. Registering through this helper keeps a clash from
 * aborting activation, and `warnIfCommandsClash` tells the user plainly to
 * disable one of the two instead of leaving half an extension working.
 */

const conflictingIds: string[] = [];

export function registerCommandSafely(id: string, callback: (...args: any[]) => any, thisArg?: any): Disposable {
    try {
        return commands.registerCommand(id, callback, thisArg);
    } catch {
        conflictingIds.push(id);
        return new Disposable(() => { /* nothing was registered */ });
    }
}

export function warnIfCommandsClash() {
    const original = extensions.getExtension('humao.rest-client');
    if (!original && conflictingIds.length === 0) {
        return;
    }
    window.showWarningMessage(
        original
            ? l10n.t('REST Client (humao.rest-client) is also installed. Both extensions register the same rest-client.* commands, so only one of them can work — please disable one of the two.')
            : l10n.t('Some commands were already registered by another extension ({0}). Please disable the extension that overlaps with this one.', conflictingIds.join(', ')));
}
