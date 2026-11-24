import { HttpResponse } from './httpResponse';

export type HttpVariableValue = string | {} | HttpResponse;

export interface HttpVariable {
    name: string;
    value?: HttpVariableValue;
    error?: any;
    warning?: any;
}

export interface HttpVariableContext {
    rawRequest: string;
    parsedRequest: string;
    /**
     * Shared by every reference of one request: the file variables are
     * resolved once for it, so `@id = {{$guid}}` is one id wherever it ends up.
     */
    request?: { fileVariables?: Promise<Map<string, string>> };
}
