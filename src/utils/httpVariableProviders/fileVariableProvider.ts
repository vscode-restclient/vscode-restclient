import { TextDocument } from 'vscode';
import * as Constants from '../../common/constants';
import { closeImports } from '../../core/imports';
import { DocumentCache } from '../../models/documentCache';
import { ResolveErrorMessage } from '../../models/httpVariableResolveResult';
import { VariableType } from '../../models/variableType';
import { EnvironmentVariableProvider } from './environmentVariableProvider';
import { HttpVariable, HttpVariableContext } from '../../models/httpVariable';
import { HttpVariableProvider } from './httpVariableProvider';
import { RequestVariableProvider } from './requestVariableProvider';
import { SystemVariableProvider } from './systemVariableProvider';

type FileVariableValue = Record<'name' | 'value', string>;

export class FileVariableProvider implements HttpVariableProvider {
    private static _instance: FileVariableProvider;

    public static get Instance(): FileVariableProvider {
        if (!this._instance) {
            this._instance = new FileVariableProvider();
        }

        return this._instance;
    }

    private readonly escapee: Map<string, string> = new Map<string, string>([
        ['n', '\n'],
        ['r', '\r'],
        ['t', '\t']
    ]);

    private readonly innerVariableProviders: HttpVariableProvider[] = [
        SystemVariableProvider.Instance,
        RequestVariableProvider.Instance,
        EnvironmentVariableProvider.Instance,
    ];

    private readonly fileVariableCache = new DocumentCache<FileVariableValue[]>();

    private constructor() {
    }

    public readonly type: VariableType = VariableType.File;

    public async has(name: string, document: TextDocument): Promise<boolean> {
        name = name.replace(/^%/, "");
        const variables = await this.getFileVariables(document);
        return variables.some(v => v.name === name);
    }

    public async get(name: string, document: TextDocument, context?: HttpVariableContext): Promise<HttpVariable> {
        const isEncoded = name.startsWith("%");
        name = name.replace(/^%/, "");
        const variables = await this.getFileVariables(document);
        const variable = variables.find(v => v.name === name);
        if (!variable) {
            return { name, error: ResolveErrorMessage.FileVariableNotExist };
        } else {
            // Once per request: every reference of it sees the same values.
            const once = context?.request;
            const variableMap = await (once
                ? (once.fileVariables ??= this.resolveFileVariables(document, variables))
                : this.resolveFileVariables(document, variables));
            let value = variableMap.get(name);
            if (value === undefined) {
                // The request's cache belongs to another document (the editor in front changed mid-request).
                return { name, error: ResolveErrorMessage.FileVariableNotExist };
            }
            if (isEncoded) {
                value = encodeURIComponent(value);
            }
            return { name, value };
        }
    }

    public async getAll(document: TextDocument): Promise<HttpVariable[]> {
        const variables = await this.getFileVariables(document);
        const variableMap = await this.resolveFileVariables(document, variables);
        return [...variableMap.entries()].map(([name, value]) => ({ name, value }));
    }

    private async getFileVariables(document: TextDocument): Promise<FileVariableValue[]> {
        if (this.fileVariableCache.has(document)) {
            return this.fileVariableCache.get(document)!;
        }

        const fileContent = document.getText();
        const variables = new Map<string, FileVariableValue>();
        // First those of the imported files (`import ./common.http`), in
        // order; then the file's own, which therefore win.
        const texts = document.uri.scheme === 'file'
            ? [...closeImports(document.fileName, fileContent).imported.map(i => i.text), fileContent]
            : [fileContent];
        for (const line of texts.flatMap(t => t.split(Constants.LineSplitterRegex))) {
            const regex = new RegExp(Constants.FileVariableDefinitionRegex, 'g');
            let match: RegExpExecArray | null;
            while (match = regex.exec(line)) {
                const [, key, originalValue] = match;
                let value = "";
                let isPrevCharEscape = false;
                for (const currentChar of originalValue) {
                    if (isPrevCharEscape) {
                        isPrevCharEscape = false;
                        value += this.escapee.get(currentChar) || currentChar;
                    } else {
                        if (currentChar === "\\") {
                            isPrevCharEscape = true;
                            continue;
                        }
                        value += currentChar;
                    }
                }
                variables.set(key, { name: key, value });
            }
        }

        const values = [...variables.values()];
        this.fileVariableCache.set(document, values);
        return values;
    }

    /**
     * The value of every file variable, each written reference resolved once
     * and in a single pass: what is put in place (an environment value, a
     * response, a value a `# @set` took) is never read again for `{{…}}`. A
     * reference to another file variable resolves that one first, also once,
     * so `@id = {{$guid}}` is the same id wherever it ends up. A cycle leaves
     * its reference as written, which the request then reports as unresolved.
     */
    private async resolveFileVariables(document: TextDocument, variables: FileVariableValue[]): Promise<Map<string, string>> {
        const written = new Map(variables.map(({ name, value }): [string, string] => [name, value]));
        const resolved = new Map<string, string>();
        const resolving = new Set<string>();

        const resolve = async (name: string): Promise<string> => {
            const known = resolved.get(name);
            if (known !== undefined) {
                return known;
            }
            resolving.add(name);
            const value = await this.substituteOnce(document, written.get(name)!, async (reference, context) => {
                if (written.has(reference)) {
                    return resolving.has(reference) ? undefined : resolve(reference);
                }
                const found = await this.fromOtherProviders(document, reference, context);
                if (found === undefined || !found.configuration) {
                    return found?.value;
                }
                // An environment value is configuration, like the file: the
                // file variables it names are resolved, once, as they always
                // were. Nothing else inside it is.
                return this.substituteOnce(document, found.value, async inner =>
                    written.has(inner) && !resolving.has(inner) ? resolve(inner) : undefined);
            });
            resolving.delete(name);
            resolved.set(name, value);
            return value;
        };

        for (const name of written.keys()) {
            await resolve(name);
        }
        return resolved;
    }

    /**
     * Replaces each `{{reference}}` of `value` with what `lookup` gives, left
     * to right, without looking again at what was put in; `undefined` keeps
     * the reference as written.
     */
    private async substituteOnce(
        document: TextDocument,
        value: string,
        lookup: (reference: string, context: { rawRequest: string; parsedRequest: string }) => Promise<string | undefined>
    ): Promise<string> {
        const variableReferenceRegex = /\{{2}(.+?)\}{2}/g;
        let result = '';
        let lastIndex = 0;
        let match: RegExpExecArray | null;
        while (match = variableReferenceRegex.exec(value)) {
            result += value.substring(lastIndex, match.index);
            lastIndex = variableReferenceRegex.lastIndex;
            const name = match[1].trim();
            const replacement = await lookup(name, { rawRequest: value, parsedRequest: result });
            result += replacement ?? `{{${name}}}`;
        }
        return result + value.substring(lastIndex);
    }

    /**
     * A system, request or environment variable, or undefined when none gives
     * a clean value. `configuration` when it is an environment value written
     * by a person, not one a `# @set` took from a server.
     */
    private async fromOtherProviders(document: TextDocument, name: string, context: { rawRequest: string; parsedRequest: string }): Promise<{ value: string; configuration: boolean } | undefined> {
        for (const provider of this.innerVariableProviders) {
            if (await provider.has(name, document, context)) {
                const { value, error, warning, literal } = await provider.get(name, document, context);
                if (error || warning) {
                    return undefined;
                }
                return { value: value as string, configuration: provider === EnvironmentVariableProvider.Instance && !literal };
            }
        }
        return undefined;
    }
}
