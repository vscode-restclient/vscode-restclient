/**
 * What `# @set` takes in this window: one set of values per workspace folder
 * and per environment, in memory only. The environment provider puts them in
 * place of the selected environment's values; the diagnostics learn of each
 * new one so a `{{token}}` stops being flagged once the login has answered.
 */
import { EventEmitter, TextDocument, Uri, workspace } from 'vscode';
import { applyCaptures, Capture, captureTargets, CaptureResult, CaptureStore } from '../core/captures';
import { CheckableResponse } from '../core/assertions';
import { closeImports } from '../core/imports';
import { EnvironmentController } from '../controllers/environmentController';

export class CapturedValues {
    private static readonly store = new CaptureStore();
    private static readonly _onDidCapture = new EventEmitter<void>();
    public static readonly onDidCapture = CapturedValues._onDidCapture.event;

    /** The values for a document (or none: a loose request) and an environment name. */
    public static values(document: Uri | string | undefined, environment: string): Map<string, string> {
        return this.store.scope(this.scopeKey(document, environment));
    }

    /**
     * Applies the captures of a request that has just answered, in the scope
     * of its document and of the environment selected now.
     */
    public static async take(captures: readonly Capture[], response: CheckableResponse, document: Uri | string | undefined): Promise<CaptureResult[]> {
        const { name } = await EnvironmentController.getCurrentEnvironment();
        const results = applyCaptures(captures, response, this.values(document, name));
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

    private static scopeKey(document: Uri | string | undefined, environment: string): string {
        const uri = typeof document === 'string' ? Uri.parse(document) : document;
        const folder = uri ? workspace.getWorkspaceFolder(uri) : undefined;
        return `${folder?.uri.toString() ?? ''}\n${environment}`;
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
