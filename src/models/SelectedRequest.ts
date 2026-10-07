import { Assertion } from '../core/assertions';
import { RequestMetadata } from './requestMetadata';

export interface SelectedRequest {
    text: string;

    metadatas: Map<RequestMetadata, string | undefined>;

    /** The `# @assert` lines of the block, to be checked against the response. */
    assertions: Assertion[];
}