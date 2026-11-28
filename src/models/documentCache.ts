import { TextDocument } from 'vscode';

type Container<T> = {
    value: T;
    version: number;
    /**
     * The document that filled the entry. A closed untitled document gives
     * its uri back, and the next one opened takes it at version 1 again: the
     * uri and the version alone handed it the values of the one before.
     */
    document: TextDocument;
};

export class DocumentCache<T> {
    private readonly _cache: Map<string, Container<T>>;

    public constructor(private readonly ignoreVersion: boolean = false) {
        this._cache = new Map<string, Container<T>>();
    }

    public get(document: TextDocument): T | undefined {
        const result = this._cache.get(this.getKey(document));
        if (result === undefined) {
            return undefined;
        }

        const { value } = result;

        return this.ignoreVersion || this.isCurrent(result, document) ? value : undefined;
    }

    public set(document: TextDocument, value: T): this {
        this._cache.set(this.getKey(document), { value, version: document.version, document });
        return this;
    }

    public delete(document: TextDocument): boolean {
        return this._cache.delete(this.getKey(document));
    }

    public clear(): void {
        this._cache.clear();
    }

    public has(document: TextDocument): boolean {
        const result = this._cache.get(this.getKey(document));
        if (result === undefined) {
            return false;
        }

        return this.ignoreVersion || this.isCurrent(result, document);
    }

    private isCurrent(result: Container<T>, document: TextDocument): boolean {
        return result.document === document && result.version === document.version;
    }

    private getKey(document: TextDocument): string {
        return `${document.uri.toString()}`;
    }
}