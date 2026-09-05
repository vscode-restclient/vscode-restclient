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
import { Entorno } from '../core/entorno';

function ajustesDelEditor(): IRestClientSettings {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../models/configurationSettings').SystemSettings.Instance;
}

/**
 * Entorno por defecto: el del editor. Es el único punto de este fichero que
 * conoce VS Code, y se carga en diferido para que el runner de terminal nunca
 * llegue a importarlo.
 */
const ENTORNO_EDITOR: Entorno = {
    avisar: (mensaje: string) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { window } = require('vscode');
        window.showWarningMessage(mensaje);
    },
    raiz: () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const raiz = require('./workspaceUtility').getWorkspaceRootPath();
        if (!raiz) {
            return undefined;
        }
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Uri } = require('vscode');
        return Uri.parse(raiz).fsPath as string;
    },
    ficheroActual: () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('./workspaceUtility').getCurrentHttpFileName();
    }
};

import { CancelableRequest, Headers, Method, OptionsOfBufferResponseBody, Response } from 'got';
import got = require('got');
import crypto = require('crypto');

const encodeUrl = require('encodeurl');
const CookieFileStore = require('tough-cookie-file-store').FileCookieStore;

/** Meta de la respuesta en cuanto llegan las cabeceras, antes del cuerpo. */
export interface MetaRespuesta {
    estado: number;
    mensaje: string;
    version: string;
    cabeceras: ResponseHeaders;
}

/** Se llama por cada trozo del cuerpo según llega: es lo que permite pintar un stream en vivo. */
export type AlRecibir = (trozo: Buffer, meta: MetaRespuesta) => void;

type Certificate = {
    cert?: Buffer;
    key?: Buffer;
    pfx?: Buffer;
    passphrase?: string;
};

export class HttpClient {
    private cookieStore: Store;

    public constructor(private readonly _entorno?: Entorno) {
        const cookieFilePath = UserDataManager.cookieFilePath;
        this.cookieStore = new CookieFileStore(cookieFilePath) as Store;
    }

    public async send(httpRequest: HttpRequest, settings?: IRestClientSettings, alRecibir?: AlRecibir): Promise<HttpResponse> {
        // Los ajustes del editor se cargan en diferido: quien llame desde la
        // terminal pasa los suyos y nunca entra aquí, que es lo que mantiene
        // este fichero libre de VS Code.
        settings = settings || ajustesDelEditor();

        const options = await this.prepareOptions(httpRequest, settings);

        let bodySize = 0;
        let headersSize = 0;
        const requestUrl = encodeUrl(httpRequest.url);
        const request: CancelableRequest<Response<Buffer>> = got.default(requestUrl, options);
        httpRequest.setUnderlyingRequest(request);
        (request as any).on('response', res => {
            if (res.rawHeaders) {
                headersSize += res.rawHeaders.map(h => h.length).reduce((a, b) => a + b, 0);
                headersSize += (res.rawHeaders.length) / 2;
            }
            const meta: MetaRespuesta = {
                estado: res.statusCode ?? 0,
                mensaje: res.statusMessage ?? '',
                version: res.httpVersion ?? '1.1',
                cabeceras: HttpClient.normalizeHeaderNames(res.headers, res.rawHeaders ?? [])
            };
            res.on('data', chunk => {
                bodySize += chunk.length;
                alRecibir?.(chunk, meta);
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
                // `Basic usuario:contraseña` con dos puntos o espacios DENTRO de
                // la contraseña: se parte por el PRIMER `:` de todo lo que sigue
                // al esquema. Antes se partía por cada espacio y por cada `:`, así
                // que «admin:it's a total eclipse» llegaba truncada (upstream
                // #1419).
                const resto = [user, ...args].join(' ');
                const dosPuntos = resto.indexOf(':');
                let credencial: string | undefined;
                if (dosPuntos >= 0) {
                    credencial = resto;
                } else if (args.length > 0) {
                    credencial = `${user}:${args.join(' ')}`;
                }
                // Sin `:` y sin segundo argumento, lo que hay ya es el base64 de
                // `usuario:contraseña`: se deja intacto, como siempre.
                if (credencial !== undefined) {
                    // La cabecera se construye aquí en vez de dejársela a `got`
                    // por `username`/`password`: got la mete en la URL y sale
                    // con escapes («it's%20a%20total%3A%20eclipse»).
                    removeHeader(options.headers!, 'Authorization');
                    (options.headers as Record<string, string>)['Authorization'] = `Basic ${base64(credencial)}`;
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
     * Avisos y raíz de rutas. Inyectarlos es lo único que separaba a este
     * cliente de poder ejecutarse fuera de VS Code.
     */
    private get entorno(): Entorno {
        return this._entorno ?? ENTORNO_EDITOR;
    }

    private resolveCertificate(absoluteOrRelativePath: string | undefined): Buffer | undefined {
        if (absoluteOrRelativePath === undefined) {
            return undefined;
        }

        if (path.isAbsolute(absoluteOrRelativePath)) {
            if (!fs.existsSync(absoluteOrRelativePath)) {
                this.entorno.avisar(`Certificate path ${absoluteOrRelativePath} doesn't exist, please make sure it exists.`);
                return undefined;
            } else {
                return fs.readFileSync(absoluteOrRelativePath);
            }
        }

        // the path should be relative path
        const rootPath = this.entorno.raiz();
        let absolutePath = '';
        if (rootPath) {
            absolutePath = path.join(rootPath, absoluteOrRelativePath);
            if (fs.existsSync(absolutePath)) {
                return fs.readFileSync(absolutePath);
            } else {
                this.entorno.avisar(`Certificate path ${absoluteOrRelativePath} doesn't exist, please make sure it exists.`);
                return undefined;
            }
        }

        const currentFilePath = this.entorno.ficheroActual();
        if (!currentFilePath) {
            return undefined;
        }

        absolutePath = path.join(path.dirname(currentFilePath), absoluteOrRelativePath);
        if (fs.existsSync(absolutePath)) {
            return fs.readFileSync(absolutePath);
        } else {
            this.entorno.avisar(`Certificate path ${absoluteOrRelativePath} doesn't exist, please make sure it exists.`);
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
