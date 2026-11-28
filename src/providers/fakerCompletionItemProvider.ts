import { CancellationToken, CompletionItem, CompletionItemKind, CompletionItemProvider, MarkdownString, Position, Range, SnippetString, TextDocument } from 'vscode';
import { fakerExampleLines, FakerPath, fakerPathBeingTyped } from '../utils/fakerShared';

/**
 * Completes the path of `{{$faker module.method}}` with every method the
 * installed Faker offers. The list is generated from the library itself
 * (scripts/generate-faker-paths.mjs, run after a Faker bump) and loaded the
 * first time it is needed, so activation does not pay for it.
 */
export class FakerCompletionItemProvider implements CompletionItemProvider {
    private static items: Promise<CompletionItem[]> | undefined;

    public async provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken): Promise<CompletionItem[] | undefined> {
        const line = document.lineAt(position.line).text;
        const typed = fakerPathBeingTyped(line.substring(0, position.character));
        if (typed === undefined) {
            return undefined;
        }

        // The whole path is replaced, including what follows the cursor.
        const after = /^[\w.]*/.exec(line.substring(position.character))![0];
        const range = new Range(position.translate(0, -typed.length), position.translate(0, after.length));

        // A failed load is not kept: the next completion tries again.
        const items = await (FakerCompletionItemProvider.items ??= FakerCompletionItemProvider.load().catch(error => {
            FakerCompletionItemProvider.items = undefined;
            throw error;
        }));
        return items.map(item => Object.assign(new CompletionItem(item.label, item.kind), item, { range }));
    }

    private static async load(): Promise<CompletionItem[]> {
        const mod: any = await import(/* webpackChunkName: "faker-paths" */ '../utils/static/fakerPaths.json');
        const { paths }: { paths: FakerPath[] } = mod.default ?? mod;
        return paths.map(FakerCompletionItemProvider.toItem);
    }

    private static toItem(entry: FakerPath): CompletionItem {
        const [module, method] = entry.path.split('.');
        const item = new CompletionItem({ label: entry.path, description: `faker.${module}` }, CompletionItemKind.Function);
        item.detail = `faker.${module}.${method}(${(entry.params ?? []).join(', ')})`;

        const doc = new MarkdownString(entry.description);
        const examples = fakerExampleLines(entry);
        if (examples.length) {
            doc.appendCodeblock(examples.join('\n'), 'http');
        }
        item.documentation = doc;

        // Required parameters become placeholders: `helpers.fromRegExp ${1:pattern}`.
        if (entry.params?.length) {
            const snippet = new SnippetString().appendText(entry.path);
            entry.params.forEach(p => snippet.appendText(' ').appendPlaceholder(p));
            item.insertText = snippet;
        } else {
            item.insertText = entry.path;
        }
        return item;
    }
}
