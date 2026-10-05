import { CurlRequestParser } from '../utils/curlRequestParser';
import { HttpRequestParser } from '../utils/httpRequestParser';
import type { IRestClientSettings } from './configurationSettings';
import { RequestParser } from './requestParser';

export class RequestParserFactory {

    private static readonly curlRegex: RegExp = /^\s*curl/i;

    public static createRequestParser(rawRequest: string): RequestParser;
    public static createRequestParser(rawRequest: string, settings: IRestClientSettings): RequestParser;
    public static createRequestParser(rawHttpRequest: string, settings?: IRestClientSettings): RequestParser {
        // Editor settings load lazily: whoever parses from the terminal
        // passes its own and never ends up importing VS Code.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const resolved: IRestClientSettings = settings ?? require('./configurationSettings').SystemSettings.Instance;
        if (RequestParserFactory.curlRegex.test(rawHttpRequest)) {
            return new CurlRequestParser(rawHttpRequest, resolved);
        } else {
            return new HttpRequestParser(rawHttpRequest, resolved);
        }
    }
}