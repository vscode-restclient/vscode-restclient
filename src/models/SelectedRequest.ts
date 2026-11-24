import { Assertion } from '../core/assertions';
import { Capture } from '../core/captures';
import { RequestMetadata } from './requestMetadata';

export interface SelectedRequest {
    text: string;

    metadatas: Map<RequestMetadata, string | undefined>;

    /** The `# @assert` lines of the block, to be checked against the response. */
    assertions: Assertion[];

    /** The `# @set` lines: what to take from the response for later requests. */
    captures: Capture[];

    /** Where those values go: the document and the environment it was resolved with. */
    captureScope: string;
}