import { Timings } from '@szmarczak/http-timer';
import { AssertionResult } from '../core/assertions';
import { getContentType } from '../utils/misc';
import { ResponseHeaders } from './base';
import { HttpRequest } from "./httpRequest";

export class HttpResponse {
    /**
     * The verdict of the request's `# @assert` lines, when it had any. It is
     * for the views and the status bar only: the body, the history and the
     * request variables see the response as it came.
     */
    public assertions?: AssertionResult[];

    public constructor(
        public statusCode: number,
        public statusMessage: string,
        public httpVersion: string,
        public headers: ResponseHeaders,
        public body: string,
        public bodySizeInBytes: number,
        public headersSizeInBytes: number,
        public bodyBuffer: Buffer,
        public timingPhases: Timings['phases'],
        public request: HttpRequest) {
    }

    public get contentType(): string | undefined {
        return getContentType(this.headers);
    }
}