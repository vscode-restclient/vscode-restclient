import { CancellationToken, CompletionItem, CompletionItemKind, CompletionItemProvider, Position, Range, SnippetString, TextDocument } from 'vscode';
import * as Constants from '../common/constants';
import { ElementType } from '../models/httpElement';
import { fakerPathBeingTyped } from '../utils/fakerShared';
import { HttpElementFactory } from '../utils/httpElementFactory';
import { VariableUtility } from "../utils/variableUtility";

export class HttpCompletionItemProvider implements CompletionItemProvider {
    public async provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken): Promise<CompletionItem[] | undefined> {
        if (!!VariableUtility.getPartialRequestVariableReferencePathRange(document, position)) {
            return undefined;
        }
        // After `{{$faker ` only Faker paths make sense: FakerCompletionItemProvider has them.
        if (fakerPathBeingTyped(document.lineAt(position).text.substring(0, position.character)) !== undefined) {
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
            // Choosing $faker opens the list of its paths straight away.
            // (HttpElement drops the `$` of system variables from their name.)
            if (e.type === ElementType.SystemVariable && `$${e.name}` === Constants.FakerVariableName) {
                item.command = { title: '', command: 'editor.action.triggerSuggest' };
            }
            return item;
        });
    }

    /** The gap between `{{` and `}}` if the cursor is inside it; `undefined` otherwise. */
    private static rangeInsideBraces(document: TextDocument, position: Position): Range | undefined {
        const line = document.lineAt(position.line).text;
        const beforeCursor = line.substring(0, position.character);
        const opens = beforeCursor.lastIndexOf('{{');
        if (opens < 0 || opens < beforeCursor.lastIndexOf('}}')) {
            return undefined;
        }
        const closes = line.indexOf('}}', position.character);
        return new Range(
            new Position(position.line, opens + 2),
            new Position(position.line, closes === -1 ? line.length : closes));
    }
}
