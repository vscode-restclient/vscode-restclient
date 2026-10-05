import * as fs from 'fs-extra';
import * as iconv from 'iconv-lite';
import * as path from 'path';
import { CookieJar, Store } from 'tough-cookie';
import * as url from 'url';
import { RequestHeaders, ResponseHeaders } from '../models/base';
import type { IRestClientSettings } from '../models/configurationSettings';
import { HttpRequest } from '../models/httpRequest';
import { HttpResponse } from '../models/httpResponse';
import { awsCognito } from './auth/awsCognito';
import { awsSignature } from './auth/awsSignature';
import { digest } from './auth/digest';
import { MimeUtility } from './mimeUtility';
import { base64, getHeader, removeHeader } from './misc';
import { convertBufferToStream, convertStreamToBuffer } from './streamUtility';
import { UserDataManager } from './userDataManager';
import { EnvironmentData } from '../core/environment';

function editorSettings(): IRestClientSettings {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../models/configurationSettings').SystemSettings.Instance;
}

/**
 * Default environment: the editor's. This is the only place in this file that
 * knows about VS Code, and it loads lazily so the terminal runner never ends
 * up importing it.
 */
const EDITOR_ENVIRONMENT: EnvironmentData = {
    warn: (message: string) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { window } = require('vscode');
        window.showWarningMessage(message);
    },
    root: () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const root = require('./workspaceUtility').getWorkspaceRootPath();
        if (!root) {
            return undefined;
        }
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Uri } = require('vscode');
        return Uri.parse(root).fsPath as string;
    },
    currentFile: () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('./workspaceUtility').getCurrentHttpFileName();
    }
};

import { CancelableRequest, Headers, Method, OptionsOfBufferResponseBody, Response } from 'got';
import got from 'got';
import * as crypto from 'crypto';

const encodeUrl = require('encodeurl');
const CookieFileStore = require('tough-cookie-file-store').FileCookieStore;

/** Response metadata as soon as the headers arrive, before the body. */
export interface ResponseMeta {
    status: number;
    message: string;
    version: string;
    headers: ResponseHeaders;
}

/** Called for each chunk of the body as it arrives: this is what lets a stream be painted live. */
export type OnReceive = (chunk: Buffer, meta: ResponseMeta) => void;

type Certificate = {
    cert?: Buffer;
    key?: Buffer;
    pfx?: Buffer;
    passphrase?: string;
};

export class HttpClient {
    private cookieStore: Store;

    public constructor(private readonly _environment?: EnvironmentData) {
        const cookieFilePath = UserDataManager.cookieFilePath;
        this.cookieStore = new CookieFileStore(cookieFilePath) as Store;
    }

    public async send(httpRequest: HttpRequest, settings?: IRestClientSettings, onReceive?: OnReceive): Promise<HttpResponse> {
        // Editor settings load lazily: a caller from the terminal passes its
        // own and never reaches this line, which is what keeps this file free
        // of VS Code.
        settings = settings || editorSettings();

        const options = await this.prepareOptions(httpRequest, settings);

        let bodySize = 0;
        let headersSize = 0;
        const requestUrl = encodeUrl(httpRequest.url);
        const request: CancelableRequest<Response<Buffer>> = got(requestUrl, options);
        httpRequest.setUnderlyingRequest(request);
        (request as any).on('response', res => {
            if (res.rawHeaders) {
                headersSize += res.rawHeaders.map(h => h.length).reduce((a, b) => a + b, 0);
                headersSize += (res.rawHeaders.length) / 2;
            }
            const meta: ResponseMeta = {
                status: res.statusCode ?? 0,
                message: res.statusMessage ?? '',
                version: res.httpVersion ?? '1.1',
                headers: HttpClient.normalizeHeaderNames(res.headers, res.rawHeaders ?? [])
            };
            res.on('data', chunk => {
                bodySize += chunk.length;
                onReceive?.(chunk, meta);
            });
        });

        const response = await request;

        const contentType = response.headers['content-type'];
        let encoding: string | undefined;
        if (contentType) {
            encoding = MimeUtility.parse(contentType).charset;
        }

        if (!encoding) {
            encoding = "utf8";
        }

        const bodyBuffer = response.body;
        let bodyString = iconv.encodingExists(encoding) ? iconv.decode(bodyBuffer, encoding) : bodyBuffer.toString();

        if (settings.decodeEscapedUnicodeCharacters) {
            bodyString = this.decodeEscapedUnicodeCharacters(bodyString);
        }

        // adjust response header case, due to the response headers in nodejs http module is in lowercase
        const responseHeaders: ResponseHeaders = HttpClient.normalizeHeaderNames(response.headers, response.rawHeaders);

        const requestBody = options.body;

        return new HttpResponse(
            response.statusCode,
            response.statusMessage!,
            response.httpVersion,
            responseHeaders,
            bodyString,
            bodySize,
            headersSize,
            bodyBuffer,
            response.timings.phases,
            new HttpRequest(
                options.method!,
                requestUrl,
                HttpClient.normalizeHeaderNames(
                    (response as any).request.options.headers as RequestHeaders,
                    Object.keys(httpRequest.headers)),
                Buffer.isBuffer(requestBody) ? convertBufferToStream(requestBody) : requestBody,
                httpRequest.rawBody,
                httpRequest.name
            ));
    }

    public async clearCookies() {
        await fs.remove(UserDataManager.cookieFilePath);
        this.cookieStore = new CookieFileStore(UserDataManager.cookieFilePath) as Store;
    }

    private async prepareOptions(httpRequest: HttpRequest, settings: IRestClientSettings): Promise<OptionsOfBufferResponseBody> {
        const originalRequestBody = httpRequest.body;
        let requestBody: string | Buffer | undefined;

        // Fix #682 Do not touch original headers in httpRequest, which may be used for retry later
        // Simply do a shadow copy here
        const clonedHeaders = Object.assign({}, httpRequest.headers);

        const authorization = getHeader(clonedHeaders, 'Authorization') as string | undefined;
        if (originalRequestBody) {
            if (typeof originalRequestBody !== 'string') {
                const buffer = await convertStreamToBuffer(originalRequestBody);
                requestBody = buffer;
                
                if (authorization) {
                    const [scheme] = authorization.split(/\s+/);
                    const normalizedScheme = scheme.toLowerCase();
                    if (normalizedScheme === 'aws' || normalizedScheme === 'cognito') {
                        clonedHeaders['X-Amz-Content-Sha256'] = crypto.createHash('sha256').update(buffer).digest('hex');
                    }
                }
            } else {
                requestBody = originalRequestBody;
            }
        }

        const options: OptionsOfBufferResponseBody = {
            headers: clonedHeaders as any as Headers,
            method: httpRequest.method as any as Method,
            body: requestBody,
            responseType: 'buffer',
            decompress: true,
            followRedirect: settings.followRedirect,
            throwHttpErrors: false,
            retry: 0,
            hooks: {
                afterResponse: [],
                beforeRequest: [],
            },
            https: {
                rejectUnauthorized: false
            }
        };

        if (settings.timeoutInMilliseconds > 0) {
            options.timeout = settings.timeoutInMilliseconds;
        }

        if (settings.rememberCookiesForSubsequentRequests) {
            options.cookieJar = new CookieJar(this.cookieStore);
        }

        // TODO: refactor auth
        if (authorization) {
            const [scheme, user, ...args] = authorization.split(/\s+/);
            const normalizedScheme = scheme.toLowerCase();
            if (normalizedScheme === 'basic' && user !== undefined) {
                // `Basic user:password` with colons or spaces INSIDE the
                // password: split on the FIRST `:` of everything after the
                // scheme. It used to split on every space and every `:`, so
                // «admin:it's a total eclipse» arrived truncated (upstream
                // #1419).
                const rest = [user, ...args].join(' ');
                const colon = rest.indexOf(':');
                let credential: string | undefined;
                if (colon >= 0) {
                    credential = rest;
                } else if (args.length > 0) {
                    credential = `${user}:${args.join(' ')}`;
                }
                // With no `:` and no second argument, what is there is already
                // the base64 of `user:password`: left untouched, as always.
                if (credential !== undefined) {
                    // The header is built here rather than left to `got` via
                    // `username`/`password`: got puts it in the URL, which
                    // escapes it («it's%20a%20total%3A%20eclipse»).
                    removeHeader(options.headers!, 'Authorization');
                    (options.headers as Record<string, string>)['Authorization'] = `Basic ${base64(credential)}`;
                }
            } else if (args.length > 0) {
                const pass = args.join(' ');
                if (normalizedScheme === 'digest') {
                    removeHeader(options.headers!, 'Authorization');
                    options.hooks!.afterResponse!.push(digest(user, pass));
                } else if (normalizedScheme === 'aws') {
                    removeHeader(options.headers!, 'Authorization');
                    options.hooks!.beforeRequest!.push(awsSignature(authorization));
                } else if (normalizedScheme === 'cognito') {
                    removeHeader(options.headers!, 'Authorization');
                   options.hooks!.beforeRequest!.push(await awsCognito(authorization));
                }
            }
        }

        // set certificate
        const certificate = this.getRequestCertificate(httpRequest.url, settings);
        Object.assign(options, certificate);

        // set proxy
        if (settings.proxy && !HttpClient.ignoreProxy(httpRequest.url, settings.excludeHostsForProxy)) {
            const proxyEndpoint = url.parse(settings.proxy);
            if (/^https?:$/.test(proxyEndpoint.protocol || '')) {
                const proxyOptions = {
                    host: proxyEndpoint.hostname,
                    port: Number(proxyEndpoint.port),
                    rejectUnauthorized: settings.proxyStrictSSL
                };

                const ctor = (httpRequest.url.startsWith('http:')
                    ? await import('http-proxy-agent')
                    : await import('https-proxy-agent')).default;

                options.agent = new ctor(proxyOptions);
            }
        }

        return options;
    }

    private decodeEscapedUnicodeCharacters(body: string): string {
        return body.replace(/\\u([0-9a-fA-F]{4})/gi, (_, g) => {
            const char = String.fromCharCode(parseInt(g, 16));
            return char === '"' ? '\\"' : char;
        });
    }

    private getRequestCertificate(requestUrl: string, settings: IRestClientSettings): Certificate | null {
        const host = url.parse(requestUrl).host;
        if (!host || !(host in settings.hostCertificates)) {
            return null;
        }

        const { cert: certPath, key: keyPath, pfx: pfxPath, passphrase } = settings.hostCertificates[host];
        const cert = this.resolveCertificate(certPath);
        const key = this.resolveCertificate(keyPath);
        const pfx = this.resolveCertificate(pfxPath);
        return { cert, key, pfx, passphrase };
    }

    private static ignoreProxy(requestUrl: string, excludeHostsForProxy: string[]): Boolean {
        if (!excludeHostsForProxy || excludeHostsForProxy.length === 0) {
            return false;
        }

        const resolvedUrl = url.parse(requestUrl);
        const hostName = resolvedUrl.hostname?.toLowerCase();
        const port = resolvedUrl.port;
        const excludeHostsProxyList = Array.from(new Set(excludeHostsForProxy.map(eh => eh.toLowerCase())));

        for (const eh of excludeHostsProxyList) {
            const urlParts = eh.split(":");
            if (!port) {
                // if no port specified in request url, host name must exactly match
                if (urlParts.length === 1 && urlParts[0] === hostName) {
                    return true;
                }
            } else {
                // if port specified, match host without port or hostname:port exactly match
                const [ph, pp] = urlParts;
                if (ph === hostName && (!pp || pp === port)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Warnings and the root for paths. Injecting them was the only thing
     * standing between this client and running outside VS Code.
     */
    private get environment(): EnvironmentData {
        return this._environment ?? EDITOR_ENVIRONMENT;
    }

    private resolveCertificate(absoluteOrRelativePath: string | undefined): Buffer | undefined {
        if (absoluteOrRelativePath === undefined) {
            return undefined;
        }

        if (path.isAbsolute(absoluteOrRelativePath)) {
            if (!fs.existsSync(absoluteOrRelativePath)) {
                this.environment.warn(`Certificate path ${absoluteOrRelativePath} doesn't exist, please make sure it exists.`);
                return undefined;
            } else {
                return fs.readFileSync(absoluteOrRelativePath);
            }
        }

        // the path should be relative path
        const rootPath = this.environment.root();
        let absolutePath = '';
        if (rootPath) {
            absolutePath = path.join(rootPath, absoluteOrRelativePath);
            if (fs.existsSync(absolutePath)) {
                return fs.readFileSync(absolutePath);
            } else {
                this.environment.warn(`Certificate path ${absoluteOrRelativePath} doesn't exist, please make sure it exists.`);
                return undefined;
            }
        }

        const currentFilePath = this.environment.currentFile();
        if (!currentFilePath) {
            return undefined;
        }

        absolutePath = path.join(path.dirname(currentFilePath), absoluteOrRelativePath);
        if (fs.existsSync(absolutePath)) {
            return fs.readFileSync(absolutePath);
        } else {
            this.environment.warn(`Certificate path ${absoluteOrRelativePath} doesn't exist, please make sure it exists.`);
            return undefined;
        }
    }

    private static normalizeHeaderNames<T extends RequestHeaders | ResponseHeaders>(headers: T, rawHeaders: string[]): T {
        const headersDic: { [key: string]: string } = rawHeaders.reduce(
            (prev, cur) => {
                if (!(cur.toLowerCase() in prev)) {
                    prev[cur.toLowerCase()] = cur;
                }
                return prev;
            }, {});
        const adjustedResponseHeaders = {} as RequestHeaders | ResponseHeaders;
        for (const header in headers) {
            const adjustedHeaderName = headersDic[header] || header;
            adjustedResponseHeaders[adjustedHeaderName] = headers[header];
        }

        return adjustedResponseHeaders as T;
    }
}
