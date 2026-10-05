export enum RequestMetadata {
    /**
     * Represents a request name and used to indicate that the request is a named request
     */
    Name = 'name',
    /**
     * Used for request confirmation, especially for critical request
     */
    Note = 'note',
    /**
     * Represents don't follow the 3XX response as redirects
     */
    NoRedirect = 'no-redirect',

    /**
     * Represents the cookie jar is disabled for this request
     */
    NoCookieJar = 'no-cookie-jar',

    /**
     * Used to allow user to interactively input variables for this request
     */
    Prompt = 'prompt',

    /**
     * Maximum time in milliseconds for this request; for a WebSocket, how
     * long to listen before closing.
     */
    Timeout = 'timeout',
}

export function fromString(value: string): RequestMetadata | undefined {
    value = value.toLowerCase();
    const enumName = (Object.keys(RequestMetadata) as Array<keyof typeof RequestMetadata>).find(k => RequestMetadata[k] === value);
    return enumName ? RequestMetadata[enumName] : undefined;
}