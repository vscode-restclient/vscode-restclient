import { ExtensionContext, l10n, Range, TextDocument, Uri, ViewColumn, window, workspace } from 'vscode';
import { namedBlock, closeImports } from '../core/imports';
import { isRequest, splitBlocks } from '../core/sequence';
import Logger from '../logger';
import { IRestClientSettings, RequestSettings, RestClientSettings } from '../models/configurationSettings';
import { HistoricalHttpRequest, HttpRequest } from '../models/httpRequest';
import { RequestMetadata } from '../models/requestMetadata';
import { RequestParserFactory } from '../models/requestParserFactory';
import { trace } from "../utils/decorator";
import { OnReceive, HttpClient } from '../utils/httpClient';
import { isEventStream } from '../core/sse';
import { talk, bodyMessages, DEFAULT_LISTEN_MS } from '../core/websocket';
import { HttpResponse } from '../models/httpResponse';
import { getHeader } from '../utils/misc';
import { RequestState, RequestStatusEntry } from '../utils/requestStatusBarEntry';
import { RequestVariableCache } from "../utils/requestVariableCache";
import { Selector } from '../utils/selector';
import { UserDataManager } from '../utils/userDataManager';
import { getCurrentTextDocument } from '../utils/workspaceUtility';
import { HttpResponseTextDocumentView } from '../views/httpResponseTextDocumentView';
import { HttpResponseWebview } from '../views/httpResponseWebview';

export class RequestController {
    private _requestStatusEntry: RequestStatusEntry;
    private _httpClient: HttpClient;
    private _webview: HttpResponseWebview;
    private _textDocumentView: HttpResponseTextDocumentView;
    private _lastRequestSettingTuple: [HttpRequest, IRestClientSettings];
    private _lastPendingRequest?: HttpRequest;

    public constructor(context: ExtensionContext) {
        this._requestStatusEntry = new RequestStatusEntry();
        this._httpClient = new HttpClient();
        this._webview = new HttpResponseWebview(context);
        this._webview.onDidCloseAllWebviewPanels(() => this._requestStatusEntry.update({ state: RequestState.Closed }));
        this._textDocumentView = new HttpResponseTextDocumentView();
    }

    @trace('Request')
    public async run(range: Range) {
        const editor = window.activeTextEditor;
        const document = getCurrentTextDocument();
        if (!editor || !document) {
            return;
        }

        const selectedRequest = await Selector.getRequest(editor, range);
        if (!selectedRequest) {
            return;
        }

        const { text, metadatas } = selectedRequest;
        const name = metadatas.get(RequestMetadata.Name);

        if (metadatas.has(RequestMetadata.Note)) {
            const note = name
                ? l10n.t('Are you sure you want to send the request "{0}"?', name)
                : l10n.t('Are you sure you want to send this request?');
            const si = l10n.t('Yes');
            const userConfirmed = await window.showWarningMessage(note, si, l10n.t('No'));
            if (userConfirmed !== si) {
                return;
            }
        }

        const requestSettings = new RequestSettings(metadatas);
        const settings: IRestClientSettings = new RestClientSettings(requestSettings);

        // parse http request
        const httpRequest = await RequestParserFactory.createRequestParser(text, settings).parseHttpRequest(name);

        if (httpRequest.method === 'WEBSOCKET') {
            await this.runWebSocket(httpRequest, settings, document);
            return;
        }

        await this.runCore(httpRequest, settings, document);
    }

    /**
     * Envía una petición de un fichero por su nombre (o la primera) y devuelve
     * la respuesta. Es lo que usan las herramientas para agentes: pasa por el
     * mismo camino que «Send Request», así que variables, entornos, secretos y
     * el panel se comportan igual que si lo hiciera una persona.
     */
    public async sendFromFile(uri: Uri, requestName?: string): Promise<HttpResponse> {
        const document = await workspace.openTextDocument(uri);
        const documentText = document.getText();
        const blocks = splitBlocks(documentText).filter(isRequest);
        let block = requestName ? blocks.find(b => b.name === requestName) : blocks[0];
        if (!block && requestName && document.uri.scheme === 'file') {
            // Puede estar en un fichero importado: se ejecuta como `run #nombre`.
            const { imported } = closeImports(document.fileName, documentText);
            if (namedBlock(requestName, documentText, imported)) {
                block = { text: `run #${requestName}`, line: blocks[0]?.line ?? 0 };
            }
        }
        if (!block) {
            throw new Error(requestName ? `there is no request named "${requestName}" in ${document.fileName}` : `there are no requests in ${document.fileName}`);
        }
        const editor = await window.showTextDocument(document, { preview: false, preserveFocus: true });
        const line = new Range(block.line, 0, block.line, 0);
        const selectedRequest = block.text.startsWith('run #')
            ? await Selector.getRequestFromText(editor.document, block.text)
            : await Selector.getRequest(editor, line);
        if (!selectedRequest) {
            throw new Error('the request could not be read');
        }
        const { text, metadatas } = selectedRequest;
        const name = metadatas.get(RequestMetadata.Name);
        const settings: IRestClientSettings = new RestClientSettings(new RequestSettings(metadatas));
        const httpRequest = await RequestParserFactory.createRequestParser(text, settings).parseHttpRequest(name);
        const response = httpRequest.method === 'WEBSOCKET'
            ? await this.runWebSocket(httpRequest, settings, document)
            : await this.runCore(httpRequest, settings, document);
        if (!response) {
            throw new Error('the request failed or was cancelled');
        }
        return response;
    }

    @trace('Rerun Request')
    public async rerun() {
        if (!this._lastRequestSettingTuple) {
            return;
        }

        const [request, settings] = this._lastRequestSettingTuple;

        // TODO: recover from last request settings
        await this.runCore(request, settings);
    }

    @trace('Cancel Request')
    public async cancel() {
        this._lastPendingRequest?.cancel();

        this._requestStatusEntry.update({ state: RequestState.Cancelled });
    }
    public async clearCookies() {
        try {
            await this._httpClient.clearCookies();
        } catch (error) {
            window.showErrorMessage(l10n.t('Error clearing cookies: {0}', error?.message));
        }
    }

    private async runCore(httpRequest: HttpRequest, settings: IRestClientSettings, document?: TextDocument): Promise<HttpResponse | undefined> {
        // clear status bar
        this._requestStatusEntry.update({ state: RequestState.Pending });

        // set last request and last pending request
        this._lastPendingRequest = httpRequest;
        this._lastRequestSettingTuple = [httpRequest, settings];

        // Un text/event-stream se pinta según llega: el panel se abre con el
        // primer trozo y va creciendo. Al terminar se renderiza entero como
        // cualquier otra respuesta, así que historial y variables no cambian.
        let enStreaming = false;
        const onReceive: OnReceive = (chunk, meta) => {
            if (settings.previewResponseInUntitledDocument || !isEventStream(getHeader(meta.headers, 'content-type') as string | undefined)) {
                return;
            }
            // Un fallo al pintar el stream no puede tumbar la petición: se
            // anota y la respuesta completa llega igual al final.
            try {
                if (!enStreaming) {
                    enStreaming = true;
                    this._webview.startStreaming(httpRequest, meta, this.resolvePreviewColumn(settings, document));
                }
                this._webview.appendChunk(chunk.toString('utf8'));
            } catch (e) {
                Logger.error('Streaming panel failed:', e);
                console.error('[rest-client] streaming panel failed:', e);
            }
        };

        // set http request
        try {
            const response = await this._httpClient.send(httpRequest, settings, onReceive);

            // check cancel
            if (httpRequest.isCancelled) {
                return undefined;
            }

            this._requestStatusEntry.update({ state: RequestState.Received, response });

            if (httpRequest.name && document) {
                RequestVariableCache.add(document, httpRequest.name, response);
            }

            try {
                const previewColumn = this.resolvePreviewColumn(settings, document);
                if (settings.previewResponseInUntitledDocument) {
                    await this._textDocumentView.render(response, previewColumn);
                } else {
                    await this._webview.render(response, previewColumn);
                }
            } catch (reason) {
                Logger.error('Unable to preview response:', reason);
                window.showErrorMessage(reason);
            }

            // persist to history json file
            await UserDataManager.addToRequestHistory(HistoricalHttpRequest.convertFromHttpRequest(httpRequest));
            return response;
        } catch (error) {
            // check cancel
            if (httpRequest.isCancelled) {
                if (enStreaming) {
                    // Cancelar es la forma normal de terminar con un stream que
                    // no acaba: lo recibido se queda en el panel.
                    this._webview.terminarStreaming(l10n.t('cancelled; the events above were received before'));
                }
                return;
            }

            if (error.code === 'ETIMEDOUT') {
                error.message = `Request timed out. Double-check your network connection and/or raise the timeout duration (currently set to ${settings.timeoutInMilliseconds}ms) as needed: 'rest-client.timeoutinmilliseconds'. Details: ${error}.`;
            } else if (error.code === 'ECONNREFUSED') {
                error.message = `The connection was rejected. Either the requested service isn’t running on the requested server/port, the proxy settings in vscode are misconfigured, or a firewall is blocking requests. Details: ${error}.`;
            } else if (error.code === 'ENETUNREACH') {
                error.message = `You don't seem to be connected to a network. Details: ${error}`;
            }
            this._requestStatusEntry.update({ state: RequestState.Error });
            Logger.error('Failed to send request:', error);
            window.showErrorMessage(error.message);
            return undefined;
        } finally {
            if (this._lastPendingRequest === httpRequest) {
                this._lastPendingRequest = undefined;
            }
        }
    }

    /**
     * WEBSOCKET url: abre, envía los mensajes del cuerpo (separados por ===),
     * escucha `@timeout` ms (3 s por omisión) y cierra. La respuesta es la
     * transcripción, con estado 101, para que el panel, el historial y las
     * aserciones la traten como a cualquier otra.
     */
    private async runWebSocket(httpRequest: HttpRequest, settings: IRestClientSettings, document?: TextDocument): Promise<HttpResponse | undefined> {
        this._requestStatusEntry.update({ state: RequestState.Pending });
        this._lastRequestSettingTuple = [httpRequest, settings];
        const t0 = Date.now();
        try {
            const ms = settings.timeoutInMilliseconds > 0 ? settings.timeoutInMilliseconds : DEFAULT_LISTEN_MS;
            const r = await talk(httpRequest.url, httpRequest.headers as Record<string, string>, bodyMessages(httpRequest.rawBody), ms);
            if (r.closedBy === 'error' && r.received.length === 0) {
                throw new Error(r.detail ?? 'WebSocket error');
            }
            const body = Buffer.from(r.transcript, 'utf8');
            const total = Date.now() - t0;
            const response = new HttpResponse(
                101, 'Switching Protocols', '1.1',
                { 'Content-Type': 'text/plain; charset=utf-8', 'X-Closed-By': r.closedBy },
                r.transcript, body.length, 0, body,
                { total } as HttpResponse['timingPhases'],
                httpRequest);
            this._requestStatusEntry.update({ state: RequestState.Received, response });
            if (httpRequest.name && document) {
                RequestVariableCache.add(document, httpRequest.name, response);
            }
            const previewColumn = this.resolvePreviewColumn(settings, document);
            if (settings.previewResponseInUntitledDocument) {
                await this._textDocumentView.render(response, previewColumn);
            } else {
                await this._webview.render(response, previewColumn);
            }
            await UserDataManager.addToRequestHistory(HistoricalHttpRequest.convertFromHttpRequest(httpRequest));
            return response;
        } catch (error) {
            this._requestStatusEntry.update({ state: RequestState.Error });
            Logger.error('WebSocket failed:', error);
            window.showErrorMessage(error instanceof Error ? error.message : String(error));
            return undefined;
        }
    }

    private resolvePreviewColumn(settings: IRestClientSettings, document?: TextDocument): ViewColumn {
        if (settings.previewColumn !== ViewColumn.Active) {
            return settings.previewColumn;
        }

        const requestEditor = document
            ? window.visibleTextEditors.find(editor => editor.document === document)
            : undefined;
        const editor = requestEditor ?? window.activeTextEditor;

        return editor?.viewColumn ?? ViewColumn.One;
    }

    public dispose() {
        this._requestStatusEntry.dispose();
        this._webview.dispose();
    }
}