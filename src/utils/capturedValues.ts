/**
 * What `# @set` takes in this window: one set of values per environment (its
 * name, the workspace folder and the `http-client.env.json` that defines it),
 * in memory only. The environment provider puts them in place of the selected
 * environment's values; the diagnostics learn of each new one so a
 * `{{token}}` stops being flagged once the login has answered.
 */
import { EventEmitter, TextDocument, workspace } from 'vscode';
import { applyCaptures, Capture, captureTargets, CaptureResult, CaptureStore } from '../core/captures';
import { CheckableResponse } from '../core/assertions';
import { closeImports } from '../core/imports';
import { environmentsFolderOf } from './editorEnvironments';

export class CapturedValues {
    private static readonly store = new CaptureStore();
    private static readonly _onDidCapture = new EventEmitter<void>();
    public static readonly onDidCapture = CapturedValues._onDidCapture.event;

    /**
     * The scope of a document under an environment. Taken when the request
     * is resolved, not when it answers: switching environments while it is in
     * flight, or rerunning it later, must not file a dev token under prod.
     */
    public static scopeOf(document: TextDocument | undefined, environment: string): string {
        const folder = document ? workspace.getWorkspaceFolder(document.uri)?.uri.toString() : undefined;
        return [folder ?? '', environmentsFolderOf(document) ?? '', environment].join('\n');
    }

    /** The values of a scope. */
    public static values(scope: string): Map<string, string> {
        return this.store.scope(scope);
    }

    /** Applies the captures of a request that has just answered, in the scope it was resolved in. */
    public static take(captures: readonly Capture[], response: CheckableResponse, scope: string): CaptureResult[] {
        const results = applyCaptures(captures, response, this.values(scope));
        if (results.some(r => r.value !== undefined)) {
            this._onDidCapture.fire();
        }
        return results;
    }

    /** For the tests: forget everything. */
    public static clear(): void {
        this.store.clear();
        this._onDidCapture.fire();
    }
}

/**
 * The names the `# @set` lines of a document, or of the files it imports,
 * take: a `{{token}}` among them is waiting for a request, not misspelt.
 */
export function setTargetsOf(document: TextDocument | undefined): Set<string> {
    if (!document) {
        return new Set();
    }
    const text = document.getText();
    const texts = [text];
    if (document.uri.scheme === 'file') {
        try {
            texts.push(...closeImports(document.fileName, text).imported.map(i => i.text));
        } catch {
            // An import that cannot be read is reported where imports are; here it only means fewer names.
        }
    }
    return new Set(texts.flatMap(captureTargets));
}
