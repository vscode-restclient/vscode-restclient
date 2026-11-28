import { CancellationToken, CodeLens, CodeLensProvider, Command, Range, TextDocument } from 'vscode';
import { Selector } from '../utils/selector';
import { onDidChangeSendRequestTitle, sendRequestTitle } from './sendRequestTitle';

export class MarkdownCodeLensProvider implements CodeLensProvider {
    public readonly onDidChangeCodeLenses = onDidChangeSendRequestTitle();

    public async provideCodeLenses(document: TextDocument, _token: CancellationToken): Promise<CodeLens[]> {
        const blocks: CodeLens[] = [];
        const title = await sendRequestTitle();

        for (const range of Selector.getMarkdownRestSnippets(document)) {
            const snippetRange = new Range(range.start.line + 1, 0, range.end.line, 0);
            const cmd: Command = {
                arguments: [document, snippetRange],
                title,
                command: 'rest-client.request',
            };
            blocks.push(new CodeLens(range, cmd));
        }

        return blocks;
    }

}