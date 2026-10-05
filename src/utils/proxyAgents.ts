import type { Agent as HttpAgent } from 'http';
import type { Agent as HttpsAgent } from 'https';
import type { HttpProxyAgent as HttpProxyAgentType } from 'http-proxy-agent';
import * as net from 'net';

/** The `agent` option of got: one agent per protocol, never a bare agent. */
export interface ProxyAgents {
    http: HttpAgent;
    https: HttpsAgent;
}

type Classes = {
    Http: new (proxy: URL, options: object) => HttpAgent & { protocol: string };
    Https: new (proxy: URL, options: object) => HttpsAgent & { protocol: string };
};

let classes: Promise<Classes> | undefined;

/** Loaded on demand, and once: most people never set a proxy. */
function load(): Promise<Classes> {
    classes ??= Promise.all([import('http-proxy-agent'), import('https-proxy-agent')]).then(([{ HttpProxyAgent }, { HttpsProxyAgent }]) => {
        /**
         * http-proxy-agent builds the absolute URL it asks the proxy for from
         * the `Host` header. A request that sets `Host` by hand, to reach one
         * virtual host of a server addressed by IP, would be sent somewhere
         * else. The URL of the request decides where it goes; the header
         * travels with it untouched.
         */
        class HttpAgentByUrl extends HttpProxyAgent<string> {
            setRequestProps(...[req, opts]: Parameters<HttpProxyAgentType<string>['setRequestProps']>): void {
                super.setRequestProps(req, opts);
                const host = (opts as { host?: string }).host;
                if (host) {
                    const target = new URL(req.path);
                    target.hostname = net.isIPv6(host) ? `[${host}]` : host;
                    req.path = String(target);
                }
            }
        }
        return { Http: HttpAgentByUrl, Https: HttpsProxyAgent };
    });
    return classes;
}

/**
 * The agents that send a request through `proxy`, or `undefined` if `proxy`
 * is not an http(s) URL.
 *
 * Both are returned whatever the request URL is, because got picks one per
 * hop: a request that starts as http and is redirected to https still goes
 * through the proxy.
 *
 * Two things this replaces (#32). The agent used to be handed to got bare,
 * which got 11 rejects before sending anything. And the agents were the 2.x
 * line, whose `agent-base` replaces `https.request` with a version that only
 * understands `(options, callback)`: from the first proxied request on, every
 * `https.request(url, options, callback)` failed, which is every https request
 * this extension sends.
 */
export async function proxyAgents(proxy: string, strictSSL: boolean): Promise<ProxyAgents | undefined> {
    let endpoint: URL;
    try {
        endpoint = new URL(proxy);
    } catch {
        return undefined;
    }
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
        return undefined;
    }

    const { Http, Https } = await load();
    // These options are about the connection to the proxy itself, when the
    // proxy is reached over TLS (`https://proxy`): whether its certificate is
    // checked, and the name it is asked for. The request's own TLS options
    // travel with the request.
    const name = endpoint.hostname.replace(/^\[|\]$/g, '');
    const options = { rejectUnauthorized: strictSSL, ...(net.isIP(name) ? {} : { servername: name }) };
    const http = new Http(endpoint, options);
    const https = new Https(endpoint, options);
    // Said out loud. Left alone, each agent works out which protocol it serves
    // by reading a stack trace, and stack traces are a process-wide setting
    // that anything sharing the process can turn off.
    http.protocol = 'http:';
    https.protocol = 'https:';
    return { http, https };
}
