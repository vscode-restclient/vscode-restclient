import { CancellationToken, CompletionItem, CompletionItemKind, CompletionItemProvider, Position, Range, SnippetString, TextDocument } from 'vscode';
import { ElementType } from '../models/httpElement';
import { HttpElementFactory } from '../utils/httpElementFactory';
import { VariableUtility } from "../utils/variableUtility";

export class HttpCompletionItemProvider implements CompletionItemProvider {
    public async provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken): Promise<CompletionItem[] | undefined> {
        if (!!VariableUtility.getPartialRequestVariableReferencePathRange(document, position)) {
            return undefined;
        }

        // Si el cursor ya está dentro de unas llaves, lo que se inserta es sólo
        // el interior y sustituye a lo que hubiera entre ellas. Antes se
        // insertaba `{{variable}}` entero después del `{{` recién escrito y
        // salía `{{{{variable}}}}`.
        const interior = HttpCompletionItemProvider.rangoDentroDeLlaves(document, position);

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

            const texto = typeof e.text === 'string' ? e.text : (e.text?.value ?? '');
            if (interior && texto.startsWith('{{') && texto.endsWith('}}')) {
                const dentro = texto.slice(2, -2).trim();
                item.range = interior;
                item.insertText = typeof e.text === 'string' ? dentro : new SnippetString(dentro);
                // Con el cursor en `{{$ti`, VS Code filtra por lo tecleado: sin
                // esto, `$timestamp` no casaba al escribir `timestamp` a secas.
                if (dentro.startsWith('$')) {
                    item.filterText = `${dentro} ${dentro.substring(1)}`;
                }
            }
            return item;
        });
    }

    /** El hueco entre `{{` y `}}` si el cursor está dentro; `undefined` si no. */
    private static rangoDentroDeLlaves(document: TextDocument, position: Position): Range | undefined {
        const linea = document.lineAt(position.line).text;
        const antes = linea.substring(0, position.character);
        const abre = antes.lastIndexOf('{{');
        if (abre < 0 || abre < antes.lastIndexOf('}}')) {
            return undefined;
        }
        const cierra = linea.indexOf('}}', position.character);
        return new Range(
            new Position(position.line, abre + 2),
            new Position(position.line, cierra === -1 ? linea.length : cierra));
    }
}
