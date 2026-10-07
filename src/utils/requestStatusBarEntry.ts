import { EOL } from 'os';
import { l10n, StatusBarAlignment, StatusBarItem, window } from 'vscode';
import { HttpResponse } from '../models/httpResponse';
import { reportLines, summarize } from '../utils/assertionReport';

const filesize = require('filesize');

type NonReceivedRequestStatus = {
    state: RequestState.Closed | RequestState.Cancelled | RequestState.Error | RequestState.Pending
};

type ReceivedRequestStatus = {
    state: RequestState.Received,
    response: HttpResponse
};

type RequestStatus = ReceivedRequestStatus | NonReceivedRequestStatus;

export enum RequestState {
    Closed,
    Pending,
    Received,
    Cancelled,
    Error,
}

export class RequestStatusEntry {
    private readonly durationEntry: StatusBarItem;

    private readonly sizeEntry: StatusBarItem;

    private readonly assertionsEntry: StatusBarItem;

    public constructor() {
        this.durationEntry = window.createStatusBarItem('duration', StatusBarAlignment.Left);
        this.durationEntry.name = 'Response Timing';
        this.sizeEntry = window.createStatusBarItem('size', StatusBarAlignment.Left);
        this.sizeEntry.name = 'Response Size';
        this.assertionsEntry = window.createStatusBarItem('assertions', StatusBarAlignment.Left);
        this.assertionsEntry.name = 'Response Assertions';
    }

    public dispose() {
        this.durationEntry.dispose();
        this.sizeEntry.dispose();
        this.assertionsEntry.dispose();
    }

    public update(status: RequestStatus) {
        this.sizeEntry.hide();
        this.assertionsEntry.hide();

        switch (status.state) {
            case RequestState.Closed:
            case RequestState.Error:
                this.durationEntry.hide();
                break;

            case RequestState.Pending:
                this.showDurationEntry(`$(sync~spin) ${l10n.t('Waiting...')}`, l10n.t('Click to cancel'), 'rest-client.cancel-request');
                break;

            case RequestState.Cancelled:
                this.showDurationEntry(`$(circle-slash) ${l10n.t('Cancelled')}`);
                break;

            case RequestState.Received:
                const response = status.response;
                const tooltip = [
                    l10n.t('Breakdown of Duration:'),
                    `Socket: ${response.timingPhases.wait?.toFixed(1) ?? 0}ms`,
                    `DNS: ${response.timingPhases.dns?.toFixed(1) ?? 0}ms`,
                    `TCP: ${response.timingPhases.tcp?.toFixed(1) ?? 0}ms`,
                    `Request: ${response.timingPhases.request?.toFixed(1) ?? 0}ms`,
                    `FirstByte: ${response.timingPhases.firstByte?.toFixed(1) ?? 0}ms`,
                    `Download: ${response.timingPhases.download?.toFixed(1) ?? 0}ms`
                ].join(EOL);

                this.showDurationEntry(`$(clock) ${response.timingPhases.total ?? 0}ms`, tooltip);
                this.showSizeEntry(response);
                this.showAssertionsEntry(response);
                break;
        }
    }

    /** Only when the request had `# @assert` lines: how many held, and which did not. */
    private showAssertionsEntry(response: HttpResponse) {
        if (!response.assertions?.length) {
            return;
        }
        const { passed, failed, total } = summarize(response.assertions);
        this.assertionsEntry.text = failed === 0 ? `$(pass) ${passed}/${total}` : `$(error) ${passed}/${total}`;
        this.assertionsEntry.tooltip = [l10n.t('{0} of {1} assertions passed', passed, total), ...reportLines(response.assertions)].join(EOL);
        this.assertionsEntry.show();
    }

    private showSizeEntry(response: HttpResponse) {
        this.sizeEntry.text = `$(database) ${filesize(response.bodySizeInBytes + response.headersSizeInBytes)}`;
        this.sizeEntry.tooltip = [
            l10n.t('Breakdown of Response Size:'),
            `Headers: ${filesize(response.headersSizeInBytes)}`,
            `Body: ${filesize(response.bodySizeInBytes)}`
        ].join(EOL);
        this.sizeEntry.show();
    }

    private showDurationEntry(text: string, tooltip?: string, command?: string) {
        this.durationEntry.text = text;
        this.durationEntry.tooltip = tooltip;
        this.durationEntry.command = command;
        this.durationEntry.show();
    }
}