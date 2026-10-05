/**
 * Parser for the `.http` format, for the terminal.
 *
 * The editor's parser also resolves variables, environments and system
 * variables, and for that it depends on VS Code's providers: using it here
 * would drag in half the editor. By the time the runner reaches this point the
 * variables are already resolved, so all that is left is reading the request.
 *
 * Covers method, URL, headers, an inline body, a body from a file with
 * `< path` (including inside a multipart, with `<@ path` so the file's
 * variables are substituted) and a pasted `curl` command.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface MinimalRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string | Buffer;
}

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'QUERY', 'WEBSOCKET'];
const LINE_BREAKS = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));
const FILE_IN_BODY = /^<(@)?\s+(.+?)\s*$/;

export function parseRequests(text: string, base: string, substitute: (t: string) => string = t => t): MinimalRequest {
    const lines = text.split(LINE_BREAKS);
    let i = 0;

    // Comments, metadata and blank lines before the request.
    while (i < lines.length && (lines[i].trim() === '' || /^\s*(#|\/\/)/.test(lines[i]) || /^\s*@[\w.-]+\s*=/.test(lines[i]) || /^\s*import\s+\S/.test(lines[i]))) {
        i++;
    }
    if (i >= lines.length) {
        throw new Error('there is no request in this block');
    }

    if (/^\s*curl\b/.test(lines[i])) {
        return parseCurl(lines.slice(i), base);
    }

    const first = lines[i++].trim();
    const parts = first.split(/\s+/);
    let method = 'GET';
    let url: string;
    if (METHODS.includes(parts[0].toUpperCase())) {
        method = parts[0].toUpperCase();
        url = parts[1] ?? '';
    } else {
        url = parts[0];
    }
    if (!url) {
        throw new Error(`cannot find the URL in "${first}"`);
    }

    // A URL can continue on the following lines if they start with ? or &.
    while (i < lines.length && /^\s*[?&]/.test(lines[i])) {
        url += lines[i++].trim();
    }

    const headers: Record<string, string> = {};
    while (i < lines.length && lines[i].trim() !== '') {
        const l = lines[i++];
        if (/^\s*(#|\/\/)/.test(l)) {
            continue;
        }
        const cutoff = l.indexOf(':');
        if (cutoff > 0) {
            headers[l.slice(0, cutoff).trim()] = l.slice(cutoff + 1).trim();
        }
    }

    // Everything after the blank line is the body, except the metadata
    // comments (@assert, @name, @timeout) that sit at the end of the block.
    const remaining = lines.slice(i + 1).filter(l => !/^\s*(?:#|\/\/)\s*@(assert|name|timeout)\b/.test(l));
    const body = readBody(remaining, headers, base, substitute);
    return { method, url, headers, body };
}

const typeOf = (headers: Record<string, string>) =>
    Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';

/**
 * The body. If any line is `< file` it is assembled as bytes: the file goes in
 * as it is (or with variables substituted for `<@ file`) and, in a multipart,
 * line breaks are CRLF with a trailing one, which is what the server expects in
 * order to read the last boundary.
 */
function readBody(lines: string[], headers: Record<string, string>, base: string, substitute: (t: string) => string): string | Buffer | undefined {
    // No files: the text as it is, trimmed.
    if (!lines.some(l => FILE_IN_BODY.test(l))) {
        const text = lines.join('\n').trim();
        return text === '' ? undefined : text;
    }
    const multipart = /multipart\//i.test(typeOf(headers));
    const newline = Buffer.from(multipart ? '\r\n' : '\n');
    // Blank lines at either end are not part of the body.
    while (lines.length && lines[0].trim() === '') { lines.shift(); }
    while (lines.length && lines[lines.length - 1].trim() === '') { lines.pop(); }
    const parts: Buffer[] = [];
    lines.forEach((l, k) => {
        const m = FILE_IN_BODY.exec(l);
        if (m) {
            const filePath = path.isAbsolute(m[2]) ? m[2] : path.join(base, m[2]);
            if (!fs.existsSync(filePath)) {
                throw new Error(`body file does not exist: ${m[2]}`);
            }
            parts.push(m[1] ? Buffer.from(substitute(fs.readFileSync(filePath, 'utf8')), 'utf8') : fs.readFileSync(filePath));
        } else {
            parts.push(Buffer.from(l, 'utf8'));
        }
        if (k < lines.length - 1 || multipart) {
            parts.push(newline);
        }
    });
    return Buffer.concat(parts);
}

/**
 * A pasted `curl` command: `-X`, `-H`, `-d`/`--data*`, `-u`, `--url`, and
 * continuations with `\` at the end of a line. What curl would do with it is
 * what gets sent.
 */
export function parseCurl(lines: string[], base: string): MinimalRequest {
    const oneLine = lines.join('\n').replace(/\\\r?\n/g, ' ').replace(/^\s*curl\b/, '');
    const args = splitArguments(oneLine);
    let method: string | undefined;
    let url = '';
    const headers: Record<string, string> = {};
    const data: string[] = [];
    let user: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const value = () => args[++i] ?? '';
        if (a === '-X' || a === '--request') { method = value().toUpperCase(); }
        else if (a.startsWith('-X') && a.length > 2) { method = a.slice(2).toUpperCase(); }
        else if (a === '-H' || a === '--header') {
            const h = value();
            const cutoff = h.indexOf(':');
            if (cutoff > 0) { headers[h.slice(0, cutoff).trim()] = h.slice(cutoff + 1).trim(); }
        }
        else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary' || a === '--data-ascii') { data.push(value()); }
        else if (a === '-u' || a === '--user') { user = value(); }
        else if (a === '--url') { url = value(); }
        else if (a === '-I' || a === '--head') { method = 'HEAD'; }
        else if (a === '-L' || a === '--location' || a === '--compressed' || a === '-s' || a === '-k' || a === '--insecure' || a === '-i') { /* no effect here */ }
        else if (!a.startsWith('-') && !url) { url = a; }
    }
    if (!url) {
        throw new Error('the curl command has no URL');
    }
    let body: string | undefined = data.length ? data.join('&') : undefined;
    if (body?.startsWith('@')) {
        const filePath = path.isAbsolute(body.slice(1)) ? body.slice(1) : path.join(base, body.slice(1));
        if (!fs.existsSync(filePath)) {
            throw new Error(`body file does not exist: ${body.slice(1)}`);
        }
        body = fs.readFileSync(filePath, 'utf8');
    }
    if (body !== undefined && !typeOf(headers)) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (user && !Object.keys(headers).some(k => k.toLowerCase() === 'authorization')) {
        headers['Authorization'] = `Basic ${Buffer.from(user, 'utf8').toString('base64')}`;
    }
    return { method: method ?? (body !== undefined ? 'POST' : 'GET'), url, headers, body };
}

/** Arguments as the shell would see them: single and double quotes, spaces inside them. */
export function splitArguments(text: string): string[] {
    const out: string[] = [];
    let actual = '';
    let inside: '"' | "'" | null = null;
    let hasAny = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inside) {
            if (c === inside) { inside = null; }
            else if (c === '\\' && inside === '"' && i + 1 < text.length) { actual += text[++i]; }
            else { actual += c; }
        } else if (c === '"' || c === "'") {
            inside = c;
            hasAny = true;
        } else if (/\s/.test(c)) {
            if (hasAny) { out.push(actual); actual = ''; hasAny = false; }
        } else {
            actual += c;
            hasAny = true;
        }
    }
    if (hasAny) {
        out.push(actual);
    }
    return out;
}
