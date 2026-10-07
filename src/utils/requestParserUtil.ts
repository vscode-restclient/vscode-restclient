import * as fs from 'fs-extra';
import * as path from 'path';
import { RequestHeaders } from "../models/base";
import { removeHeader } from './misc';

export function parseRequestHeaders(headerLines: string[], defaultHeaders: RequestHeaders, url: string): RequestHeaders {
    // message-header = field-name ":" [ field-value ]
    const headers: RequestHeaders = {};
    const headerNames: { [key: string]: string } = {};
    headerLines.forEach(headerLine => {
        let fieldName: string;
        let fieldValue: string;
        const separatorIndex = headerLine.indexOf(':');
        if (separatorIndex === -1) {
            fieldName = headerLine.trim();
            fieldValue = '';
        } else {
            fieldName = headerLine.substring(0, separatorIndex).trim();
            fieldValue = headerLine.substring(separatorIndex + 1).trim();
        }

        const normalizedFieldName = fieldName.toLowerCase();
        if (!headerNames[normalizedFieldName]) {
            headerNames[normalizedFieldName] = fieldName;
            headers[fieldName] = fieldValue;
        } else {
            const splitter = normalizedFieldName === 'cookie' ? ';' : ',';
            headers[headerNames[normalizedFieldName]] += `${splitter}${fieldValue}`;
        }
    });

    if (url[0] !== '/') {
        removeHeader(defaultHeaders, 'host');
    }

    return { ...defaultHeaders, ...headers };
}

/** Editor utilities, only when we are running inside it. */
function inEditor(): typeof import('./workspaceUtility') | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('vscode');
    } catch {
        return undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./workspaceUtility');
}

export async function resolveRequestBodyPath(refPath: string): Promise<string | undefined> {
    if (path.isAbsolute(refPath)) {
        return (await fs.pathExists(refPath)) ? refPath : undefined;
    }

    // The editor is consulted lazily: outside VS Code this block does not run
    // and the path is resolved against the current file, further down.
    const workspaceRoot = inEditor()?.getWorkspaceRootPath();
    if (workspaceRoot) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Uri } = require('vscode');
        const absolutePath = path.join(Uri.parse(workspaceRoot).fsPath, refPath);
        if (await fs.pathExists(absolutePath)) {
            return absolutePath;
        }
    }

    const currentFile = inEditor()?.getCurrentTextDocument()?.fileName;
    if (currentFile) {
        const absolutePath = path.join(path.dirname(currentFile), refPath);
        if (await fs.pathExists(absolutePath)) {
            return absolutePath;
        }
    }

    return undefined;
}