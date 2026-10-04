/**
 * Run every request in a file, in order.
 *
 * The second most upvoted request in the original project (+62 votes since
 * 2020), and half of what a `.http` file needs to be useful in continuous
 * integration: without a sequence there is no suite, and without a suite there
 * is no reason to prefer a file over a desktop tool.
 */

/** A block of a file: its text and where it starts, so errors can be located. */
export interface Block {
    text: string;
    /** Line (0-based) where the block starts within the file. */
    line: number;
    name?: string;
}

const LINE_BREAK = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));
const SEPARATOR_RE = /^#{3,}/;
const NAME_RE = /^\s*(?:#|\/\/)\s*@name\s+(\S+)/m;

/**
 * Splits a `.http` file on its separators.
 *
 * A `###` at the start of a line ALWAYS separates, without checking whether we
 * are inside a body. That looks crude, and it is, but it is exactly what REST
 * Client has done since 2016 (`Selector.getDelimiterRows`), and the files
 * people have already written rely on it. Being cleverer here would break the
 * compatibility that is the only thing making this fork a drop-in.
 *
 * Known inherited limitation: a body carrying `###` at the start of a line —
 * Markdown inside JSON, say — is split in two. The way out is to indent that
 * line or move the body to an external file with `< body.json`.
 */
export function splitBlocks(text: string): Block[] {
    const lines = text.split(LINE_BREAK);
    const blocks: Block[] = [];
    let actual: string[] = [];
    let inicio = 0;

    const close = () => {
        const t = actual.join(String.fromCharCode(10));
        if (t.trim().length > 0) {
            blocks.push({ text: t, line: inicio, name: NAME_RE.exec(t)?.[1] });
        }
        actual = [];
    };

    for (let i = 0; i < lines.length; i++) {
        if (SEPARATOR_RE.test(lines[i])) {
            close();
            inicio = i + 1;
            continue;
        }
        actual.push(lines[i]);
    }
    close();
    return blocks;
}

export interface ExecutedStep {
    name: string;
    line: number;
    status?: number;
    ms: number;
    error?: string;
    /** Response body, for the assertions and the report. */
    body?: string;
    headers?: Record<string, string | undefined>;
}

export interface SequenceOptions {
    /** Sends an already resolved block and returns the response. */
    enviar(block: Block): Promise<{ status: number; body: string; headers: Record<string, string | undefined> }>;
    /** Substitutes variables using what earlier requests have already returned. */
    resolve?(block: Block): Promise<Block>;
    /** By default, a failure stops the sequence. */
    continueOnFailure?: boolean;
    /** Called as each step finishes, so progress can be reported. */
    alTerminarPaso?(step: ExecutedStep): void;
}

/**
 * Runs the blocks in order. Each response becomes available to the next block
 * before it is resolved, which is what makes `{{login.response.body.$.token}}`
 * chain exactly as it does when sending by hand.
 *
 * A failure stops the sequence unless asked otherwise: chaining on a response
 * that never arrived produces errors nobody can read.
 */
export async function runSequence(blocks: Block[], options: SequenceOptions): Promise<ExecutedStep[]> {
    const hechos: ExecutedStep[] = [];

    for (const block of blocks) {
        const t0 = Date.now();
        // The name comes from the resolved block: a `run #login` is called login.
        let name = block.name ?? `#${hechos.length + 1}`;
        let step: ExecutedStep;
        try {
            const ready = options.resolve ? await options.resolve(block) : block;
            name = ready.name ?? name;
            const r = await options.enviar(ready);
            step = { name, line: block.line, status: r.status, body: r.body, headers: r.headers, ms: Date.now() - t0 };
        } catch (e) {
            step = { name, line: block.line, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
        }
        hechos.push(step);
        options.alTerminarPaso?.(step);
        if (step.error && !options.continueOnFailure) {
            break;
        }
    }
    return hechos;
}

const LINEA_DECLARACION = /^\s*(?:(?:#|\/\/).*|@[\w.-]+\s*=.*|import\s+\S.*)?$/;

/** A block with only `import`, `@variables` and comments is not a request. */
export function isRequest(block: Block): boolean {
    return block.text.split(LINE_BREAK).some(l => !LINEA_DECLARACION.test(l));
}

export interface RequestSummary {
    name?: string;
    method: string;
    url: string;
    /** Line (0-based) of the block in the file. */
    line: number;
}

/**
 * Qué peticiones hay en un fichero, sin resolver variables ni enviar nada:
 * lo que un agente necesita para decidir cuál lanzar.
 */
export function requestSummaries(text: string): RequestSummary[] {
    return splitBlocks(text).filter(isRequest).map(b => {
        const primera = b.text.split(LINE_BREAK).find(l => !LINEA_DECLARACION.test(l))!.trim();
        const m = /^([A-Z]+)\s+(\S.*)$/.exec(primera);
        const run = /^run\s+#(\S+)/.exec(primera);
        if (run) {
            return { name: b.name, method: 'RUN', url: `#${run[1]}`, line: b.line };
        }
        return { name: b.name, method: m ? m[1] : 'GET', url: (m ? m[2] : primera).replace(/\s+HTTP\/.*$/i, ''), line: b.line };
    });
}
