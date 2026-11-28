// What is left unresolved after the variables of a request were substituted.
// Shared by the editor, the terminal runner and the MCP server, so that the
// three refuse the same text for the same reason and with the same names.
// No `vscode` here.

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t' };

/**
 * The value of `@name = value`, from what is written after the `=`. Blanks
 * around it do not count, unless it is wholly in double or single quotes:
 * then the quotes go and what is inside them stays, blanks included, so
 * `@pad = "  x  "` keeps its spaces and `@empty = ""` is empty. A quote that
 * does not close at the end of the line (`"a" "b"`, `"open`) is text. In
 * either case `\n`, `\r` and `\t` are line feed, carriage return and tab,
 * and a backslash before any other character leaves that character, so
 * `\"` inside double quotes is a quote. The editor and the runner read file
 * variables through this, so a value is the same in both.
 */
export function fileVariableValue(written: string): string {
    let text = written.trim();
    const quote = text[0];
    if (text.length >= 2 && (quote === '"' || quote === "'")) {
        let i = 1;
        while (i < text.length && text[i] !== quote) {
            i += text[i] === '\\' ? 2 : 1;
        }
        if (i === text.length - 1) {
            text = text.slice(1, -1);
        }
    }
    let value = '';
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\' && i + 1 < text.length) {
            i++;
            value += ESCAPES[text[i]] ?? text[i];
        } else {
            value += text[i];
        }
    }
    return value;
}

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
