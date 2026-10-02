/**
 * Ejecutar todas las peticiones de un fichero en orden.
 *
 * Es la petición número dos más votada del proyecto original (+62 votos desde
 * 2020) y la mitad de lo que hace falta para que un `.http` sirva en
 * integración continua: sin secuencia no hay suite, y sin suite no hay motivo
 * para preferir un fichero a una herramienta de escritorio.
 */

/** Un bloque de fichero: su texto y dónde empieza, para poder situar errores. */
export interface Block {
    text: string;
    /** Línea (base 0) donde empieza el bloque dentro del fichero. */
    line: number;
    name?: string;
}

const SALTOS = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));
const SEPARADOR = /^#{3,}/;
const NOMBRE = /^\s*(?:#|\/\/)\s*@name\s+(\S+)/m;

/**
 * Trocea un fichero `.http` por sus separadores.
 *
 * Un `###` al principio de línea separa SIEMPRE, sin mirar si estamos dentro
 * de un cuerpo. Parece tosco y lo es, pero es exactamente lo que hace REST
 * Client desde 2016 (`Selector.getDelimiterRows`), y los ficheros que la gente
 * ya tiene escritos cuentan con ello. Ser más listo aquí rompería la
 * compatibilidad, que es lo único que hace este fork instalable sin trabajo.
 *
 * Limitación heredada y conocida: un cuerpo que lleve `###` al principio de una
 * línea —un Markdown dentro de un JSON, por ejemplo— se parte en dos. La salida
 * es indentar esa línea o usar un fichero externo con `< cuerpo.json`.
 */
export function splitBlocks(text: string): Block[] {
    const lines = text.split(SALTOS);
    const blocks: Block[] = [];
    let actual: string[] = [];
    let inicio = 0;

    const cerrar = () => {
        const t = actual.join(String.fromCharCode(10));
        if (t.trim().length > 0) {
            blocks.push({ text: t, line: inicio, name: NOMBRE.exec(t)?.[1] });
        }
        actual = [];
    };

    for (let i = 0; i < lines.length; i++) {
        if (SEPARADOR.test(lines[i])) {
            cerrar();
            inicio = i + 1;
            continue;
        }
        actual.push(lines[i]);
    }
    cerrar();
    return blocks;
}

export interface ExecutedStep {
    name: string;
    line: number;
    status?: number;
    ms: number;
    error?: string;
    /** Cuerpo de la respuesta, para las aserciones y el informe. */
    body?: string;
    headers?: Record<string, string | undefined>;
}

export interface SequenceOptions {
    /** Envía un bloque ya resuelto y devuelve la respuesta. */
    enviar(block: Block): Promise<{ status: number; body: string; headers: Record<string, string | undefined> }>;
    /** Sustituye variables usando lo que ya han devuelto las peticiones previas. */
    resolver?(block: Block): Promise<Block>;
    /** Por defecto, un fallo detiene la secuencia. */
    continueOnFailure?: boolean;
    /** Se llama al terminar cada paso, para poder ir informando. */
    alTerminarPaso?(step: ExecutedStep): void;
}

/**
 * Ejecuta los bloques en orden. Cada respuesta queda disponible para el
 * siguiente bloque antes de resolverlo, que es lo que permite encadenar
 * `{{login.response.body.$.token}}` igual que al enviar a mano.
 *
 * Un fallo detiene la secuencia salvo que se pida lo contrario: encadenar sobre
 * una respuesta que nunca llegó produce errores que no se entienden.
 */
export async function runSequence(blocks: Block[], options: SequenceOptions): Promise<ExecutedStep[]> {
    const hechos: ExecutedStep[] = [];

    for (const block of blocks) {
        const t0 = Date.now();
        // El nombre se toma del bloque ya resuelto: un `run #login` se llama login.
        let name = block.name ?? `#${hechos.length + 1}`;
        let step: ExecutedStep;
        try {
            const ready = options.resolver ? await options.resolver(block) : block;
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

/** Un bloque que sólo tiene `import`, `@variables` y comentarios no es una petición. */
export function isRequest(block: Block): boolean {
    return block.text.split(SALTOS).some(l => !LINEA_DECLARACION.test(l));
}

export interface RequestSummary {
    name?: string;
    method: string;
    url: string;
    /** Línea (base 0) del bloque en el fichero. */
    line: number;
}

/**
 * Qué peticiones hay en un fichero, sin resolver variables ni enviar nada:
 * lo que un agente necesita para decidir cuál lanzar.
 */
export function requestSummaries(text: string): RequestSummary[] {
    return splitBlocks(text).filter(isRequest).map(b => {
        const primera = b.text.split(SALTOS).find(l => !LINEA_DECLARACION.test(l))!.trim();
        const m = /^([A-Z]+)\s+(\S.*)$/.exec(primera);
        const run = /^run\s+#(\S+)/.exec(primera);
        if (run) {
            return { name: b.name, method: 'RUN', url: `#${run[1]}`, line: b.line };
        }
        return { name: b.name, method: m ? m[1] : 'GET', url: (m ? m[2] : primera).replace(/\s+HTTP\/.*$/i, ''), line: b.line };
    });
}
