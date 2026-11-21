// URL helpers on top of the WHATWG `URL` class, replacing the deprecated
// `url.parse()`. `URL` decides whether the text is a valid absolute URL;
// what the user wrote decides what we compare and show, because `URL`
// canonicalises things `url.parse()` left alone and users wrote literally
// in their settings and see in the outline:
//   - the default port of the scheme disappears (`https://foo.com:443` loses
//     `443`), leading zeros of a port go, IPv6 literals collapse
//     (`[0:0:0:0:0:0:0:1]` becomes `[::1]`) and IPv4 forms are rewritten;
//   - non-ASCII in the path is percent-encoded (`/café` becomes `/caf%C3%A9`).
// A string that is not an absolute URL yields `undefined` instead of an
// exception, because a request line in a .http file may be a bare path.
// No `vscode` here: the runner and the MCP server share this file.

/**
 * `new URL(input)` when the text is an absolute URL with an authority
 * (`scheme://host…`); `undefined` for anything else. The `URL` class alone
 * would accept `localhost:3000/x` as scheme `localhost:` with path `3000/x`,
 * the same trap `url.parse()` fell into.
 */
export function tryParseUrl(input: string): URL | undefined {
    if (!hasProtocol(input)) {
        return undefined;
    }
    try {
        return new URL(input);
    } catch {
        return undefined;
    }
}

/**
 * True when the text starts with a scheme followed by `//` (`https://…`).
 * `localhost:3000/api` is not a scheme, although `url.parse()` reported
 * `localhost:` as one.
 */
export function hasProtocol(input: string): boolean {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim());
}

/**
 * The port as written in the authority (`443` even though `URL` drops it,
 * `08080` with its zero); `undefined` when none was written.
 */
export function explicitPort(input: string, parsed: URL): string | undefined {
    return splitAuthority(input, parsed).port;
}

/**
 * `host` as `url.parse()` returned it: the host name as written, lowercased,
 * plus the port as written. An internationalised name is the punycode form,
 * as before.
 */
export function hostAsWritten(input: string, parsed: URL): string {
    const { hostname, port } = splitAuthority(input, parsed);
    return port ? `${hostname}:${port}` : hostname;
}

/** The host name without the brackets of an IPv6 literal, as `url.parse().hostname` had it. */
export function bareHostname(input: string, parsed: URL): string {
    const { hostname } = splitAuthority(input, parsed);
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Path plus query string as written after the authority, without the
 * fragment; `/` when there is none. Shown to the user, so no encoding and
 * no dot normalisation.
 */
export function pathAsWritten(input: string): string {
    const rest = input.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const start = rest.search(/[/?#]/);
    if (start < 0) {
        return '/';
    }
    const hash = rest.indexOf('#', start);
    const path = rest.slice(start, hash < 0 ? undefined : hash);
    return path.startsWith('/') ? path : `/${path}`;
}

/** Path plus query string as `URL` serialises them, which is what goes on the wire. */
export function pathWithQuery(parsed: URL): string {
    return parsed.pathname + parsed.search;
}

/**
 * The query parameters of a URL that may be bare (`/items?a=1&a=2`), in
 * order and with repeated names kept, as `url.parse(url, true).query` had
 * them. A `+` decodes to a space and a name without `=` has an empty value.
 */
export function queryParameters(input: string): [string, string][] {
    const start = input.indexOf('?');
    if (start < 0) {
        return [];
    }
    const hash = input.indexOf('#', start);
    const search = input.slice(start + 1, hash < 0 ? undefined : hash);
    return [...new URLSearchParams(search)];
}

/**
 * `link` resolved against `base` (a URI string such as `file:///c%3A/dir/`),
 * as `url.resolve(base, link)` did; the link itself when the base is not a URL.
 */
export function resolveAgainst(base: string, link: string): string {
    try {
        return new URL(link, base).href;
    } catch {
        return link;
    }
}

/**
 * What the outline shows for a request without a name: `METHOD path?query`
 * as written, with the host (port as written) as its container. A bare path
 * or a host without a scheme is shown as written, with no container.
 */
export function requestOutline(method: string, requestUrl: string): { name: string; host: string } {
    const parsed = tryParseUrl(requestUrl);
    return {
        name: `${method} ${parsed ? pathAsWritten(requestUrl) : requestUrl}`,
        host: parsed ? hostAsWritten(requestUrl, parsed) : '',
    };
}

/** Host name (lowercased; punycode when not ASCII) and port, both as written, from the authority of `input`. */
function splitAuthority(input: string, parsed: URL): { hostname: string; port: string | undefined } {
    const rest = input.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const end = rest.search(/[/?#]/);
    let authority = end >= 0 ? rest.slice(0, end) : rest;
    const at = authority.lastIndexOf('@');
    if (at >= 0) {
        authority = authority.slice(at + 1);
    }
    let hostname = authority;
    let port: string | undefined;
    const colon = authority.lastIndexOf(':');
    if (colon > authority.lastIndexOf(']')) {
        const candidate = authority.slice(colon + 1);
        if (/^\d+$/.test(candidate)) {
            port = candidate;
        }
        hostname = authority.slice(0, colon);
    }
    if (/[^\x20-\x7e]/.test(hostname)) {
        hostname = parsed.hostname;
    }
    return { hostname: hostname.toLowerCase(), port };
}
