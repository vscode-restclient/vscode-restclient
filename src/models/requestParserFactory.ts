import { CurlRequestParser } from '../utils/curlRequestParser';
import { HttpRequestParser } from '../utils/httpRequestParser';
import type { IRestClientSettings } from './configurationSettings';
import { RequestParser } from './requestParser';

export class RequestParserFactory {

    private static readonly curlRegex: RegExp = /^\s*curl/i;

    public static createRequestParser(rawRequest: string): RequestParser;
    public static createRequestParser(rawRequest: string, settings: IRestClientSettings): RequestParser;
    public static createRequestParser(rawHttpRequest: string, settings?: IRestClientSettings): RequestParser {
        // Los ajustes del editor se cargan en diferido: quien parsea desde la
        // terminal pasa los suyos y nunca llega a importar VS Code.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const resolved: IRestClientSettings = settings ?? require('./configurationSettings').SystemSettings.Instance;
        if (RequestParserFactory.curlRegex.test(rawHttpRequest)) {
            return new CurlRequestParser(rawHttpRequest, resolved);
        } else {
            return new HttpRequestParser(rawHttpRequest, resolved);
        }
    }
}