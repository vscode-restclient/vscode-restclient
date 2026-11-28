import { CancellationToken, CodeLens, CodeLensProvider, Command, Range, TextDocument } from 'vscode';
import * as Constants from '../common/constants';
import { Selector } from '../utils/selector';
import { onDidChangeSendRequestTitle, sendRequestTitle } from './sendRequestTitle';

export class HttpCodeLensProvider implements CodeLensProvider {
    public readonly onDidChangeCodeLenses = onDidChangeSendRequestTitle();

    public async provideCodeLenses(document: TextDocument, token: CancellationToken): Promise<CodeLens[]> {
        const blocks: CodeLens[] = [];
        const title = await sendRequestTitle();
        const lines: string[] = document.getText().split(Constants.LineSplitterRegex);
        const requestRanges: [number, number][] = Selector.getRequestRanges(lines);

        for (const [blockStart, blockEnd] of requestRanges) {
            const range = new Range(blockStart, 0, blockEnd, 0);
            const cmd: Command = {
                arguments: [document, range],
                title,
                command: 'rest-client.request'
            };
            blocks.push(new CodeLens(range, cmd));
        }

        return blocks;
    }
}