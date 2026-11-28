// What is left unresolved after the variables of a request were substituted.
// Shared by the editor, the terminal runner and the MCP server, so that the
// three refuse the same text for the same reason and with the same names.
// No `vscode` here.

/** The per-request setting that sends the text as it is, `{{…}}` included. */
export const ALLOW_UNRESOLVED = 'allow-unresolved';

const FILE_VARIABLE_LINE = /^\s*@([^\s=]+)\s*=/;
const SEPARATOR_LINE = /^\s*#{3,}/;
const DIRECTIVE_LINE = /^\s*(?:#+|\/{2,})\s*@[\w-]+/;
const DESCRIPTION_LINE = /^\s*(?:#+|\/{2,})(.*)$/;

/**
 * The description of each file variable of a text: the `#` or `//` comment
 * lines right above its `@name = value`, joined. A blank line, another
 * variable, a `###` separator or a directive (`# @name`, `# @prompt`…) ends
 * it, so a comment only describes the variable it sits on. When a variable
 * is defined twice the last definition wins, as its value does, even if
 * that one has no description. Only shown (hover, completion); the value is
 * read as before.
 */
export function fileVariableDescriptions(text: string): Map<string, string> {
    const descriptions = new Map<string, string>();
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
        const name = FILE_VARIABLE_LINE.exec(line)?.[1];
        if (name === undefined) {
            continue;
        }
        const parts: string[] = [];
        for (let above = index - 1; above >= 0; above--) {
            const comment = lines[above];
            const m = DESCRIPTION_LINE.exec(comment);
            if (!m || SEPARATOR_LINE.test(comment) || DIRECTIVE_LINE.test(comment)) {
                break;
            }
            parts.unshift(m[1].trim());
        }
        const description = parts.filter(Boolean).join(' ');
        if (description) {
            descriptions.set(name, description);
        } else {
            descriptions.delete(name);
        }
    }
    return descriptions;
}

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
