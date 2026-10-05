import { CancellationToken, CompletionItem, CompletionItemKind, CompletionItemProvider, Position, Range, SnippetString, TextDocument } from 'vscode';
import { ElementType } from '../models/httpElement';
import { HttpElementFactory } from '../utils/httpElementFactory';
import { VariableUtility } from "../utils/variableUtility";

export class HttpCompletionItemProvider implements CompletionItemProvider {
    public async provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken): Promise<CompletionItem[] | undefined> {
        if (!!VariableUtility.getPartialRequestVariableReferencePathRange(document, position)) {
            return undefined;
        }

        // If the cursor is already inside braces, only the inside is inserted
        // and it replaces whatever was between them. It used to insert the
        // whole `{{variable}}` after the `{{` just typed, which produced
        // `{{{{variable}}}}`.
        const inner = HttpCompletionItemProvider.rangeInsideBraces(document, position);

        const elements = await HttpElementFactory.getHttpElements(document, document.lineAt(position).text);
        return elements.map(e => {
            const item = new CompletionItem(e.name);
            item.detail = `HTTP ${ElementType[e.type]}`;
            item.documentation = e.description;
            item.insertText = e.text;
            item.kind = e.type in [ElementType.SystemVariable, ElementType.EnvironmentCustomVariable, ElementType.FileCustomVariable, ElementType.RequestCustomVariable]
                ? CompletionItemKind.Variable
                : e.type === ElementType.Method
                    ? CompletionItemKind.Method
                    : e.type === ElementType.Header
                        ? CompletionItemKind.Property
                        : CompletionItemKind.Field;

            const text = typeof e.text === 'string' ? e.text : (e.text?.value ?? '');
            if (inner && text.startsWith('{{') && text.endsWith('}}')) {
                const inside = text.slice(2, -2).trim();
                item.range = inner;
                item.insertText = typeof e.text === 'string' ? inside : new SnippetString(inside);
                // With the cursor at `{{$ti`, VS Code filters by what was typed:
                // without this, `$timestamp` did not match a bare `timestamp`.
                if (inside.startsWith('$')) {
                    item.filterText = `${inside} ${inside.substring(1)}`;
                }
            }
            return item;
        });
    }

    /** The gap between `{{` and `}}` if the cursor is inside it; `undefined` otherwise. */
    private static rangeInsideBraces(document: TextDocument, position: Position): Range | undefined {
        const line = document.lineAt(position.line).text;
        const before = line.substring(0, position.character);
        const opens = before.lastIndexOf('{{');
        if (opens < 0 || opens < before.lastIndexOf('}}')) {
            return undefined;
        }
        const closes = line.indexOf('}}', position.character);
        return new Range(
            new Position(position.line, opens + 2),
            new Position(position.line, closes === -1 ? line.length : closes));
    }
}
