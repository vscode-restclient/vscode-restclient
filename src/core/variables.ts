// What is left unresolved after the variables of a request were substituted.
// Shared by the editor, the terminal runner and the MCP server, so that the
// three refuse the same text for the same reason and with the same names.
// No `vscode` here.

/** The per-request setting that sends the text as it is, `{{…}}` included. */
export const ALLOW_UNRESOLVED = 'allow-unresolved';

const REFERENCE = /\{\{([^{}]+)\}\}/g;
const COMMENT_LINE = /^\s*(?:#|\/\/)/;
/** A file variable definition or an `import`: the parsers do not send these lines. */
const DECLARATION_LINE = /^\s*(?:@[\w.-]+\s*=|import\s+\S)/;
/** The metadata comments the parsers drop wherever they sit, the end of the block included. */
const METADATA_LINE = /^\s*(?:#|\/\/)\s*@(?:assert|set(?=\s|$)|name|timeout|note|prompt|no-redirect|no-cookie-jar|allow-unresolved)\b/i;

/**
 * The `{{…}}` references still present in what will be sent, in order and
 * without repeats. Comments, `@variable = …` definitions and `import` lines
 * above and among the request line and the headers do not count, nor do the
 * metadata comments (`# @assert …`) wherever they sit; a body line that
 * starts with `#` is body, and counts.
 */
export function unresolvedVariables(text: string): string[] {
    const names: string[] = [];
    let inBody = false;
    let seenRequestLine = false;
    for (const line of text.split(/\r?\n/)) {
        if (METADATA_LINE.test(line)) {
            continue;
        }
        if (!inBody) {
            if (line.trim() === '') {
                inBody = seenRequestLine;
                continue;
            }
            if (COMMENT_LINE.test(line) || (!seenRequestLine && DECLARATION_LINE.test(line))) {
                continue;
            }
            seenRequestLine = true;
        }
        for (const match of line.matchAll(REFERENCE)) {
            const name = match[1].trim();
            if (name && !names.includes(name)) {
                names.push(name);
            }
        }
    }
    return names;
}

/**
 * True when the block carries `# @allow-unresolved` (or `// …`) among the
 * comments above its request line (variable definitions and imports may
 * sit there too), which is where the editor reads the per-request
 * settings; case does not matter, and text after the name is ignored, as
 * the editor does.
 */
export function allowsUnresolved(text: string): boolean {
    const setting = new RegExp(`^\\s*(?:#|\\/\\/)\\s*@${ALLOW_UNRESOLVED}(?:\\s|$)`, 'i');
    for (const line of text.split(/\r?\n/)) {
        if (setting.test(line)) {
            return true;
        }
        if (line.trim() !== '' && !COMMENT_LINE.test(line) && !DECLARATION_LINE.test(line)) {
            return false;
        }
    }
    return false;
}

/** `unresolved variable: host` or `unresolved variables: host, token`. */
export function unresolvedSummary(names: readonly string[]): string {
    return `unresolved variable${names.length === 1 ? '' : 's'}: ${names.join(', ')}`;
}

/**
 * The names that make the request unsendable: none when everything resolved
 * or when the block asks for the text to go as it is.
 */
export function blockingUnresolved(text: string): string[] {
    return allowsUnresolved(text) ? [] : unresolvedVariables(text);
}
