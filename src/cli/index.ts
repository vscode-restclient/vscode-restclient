/**
 * httpkeeper — el mismo fichero .http, ejecutado desde la terminal.
 *
 *   httpkeeper peticiones.http [--env dev] [--var host=https://api] [--secret KEY=valor]
 *                              [--continuar] [--json] [--timeout ms]
 *
 * Es la petición número seis más votada del proyecto original (+44 votos desde
 * 2019) y lo que convierte un fichero de peticiones en una prueba de
 * integración: sale con código 1 si alguna aserción falla, que es lo único que
 * un servidor de integración continua necesita entender.
 */
import * as crypto from 'crypto';
import { faker } from '@faker-js/faker/locale/en';
import { fakerRegex, resolveFakerPath } from '../utils/fakerShared';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { entornoTerminal } from '../core/entorno';
import { carpetaDeEntornos, leerEntornos } from '../core/entornosJetBrains';
import { cerrarImportaciones, Importado, resolverRun, variablesConImportados } from '../core/importaciones';
import { parsear } from './parserMinimo';
import { Bloque, ejecutarSecuencia, esPeticion, trocear } from '../core/secuencia';
import { comprobar, leerAserciones, Resultado } from '../core/aserciones';
import { esEventStream } from '../core/sse';
import { hablar, mensajesDelCuerpo, MS_ESCUCHA_POR_DEFECTO } from '../core/websocket';
import { aJunit } from '../core/junit';

export interface Opciones {
    fichero: string;
    variables: Record<string, string>;
    secretos: Record<string, string>;
    entorno?: string;
    continuar: boolean;
    json: boolean;
    timeoutMs: number;
    /** Sólo la petición con este nombre (lo usa el servidor MCP). */
    solo?: string;
    /** Ruta del informe JUnit XML, si se pide. */
    junit?: string;
}

export const USO = 'uso: httpkeeper <fichero.http> [--env nombre] [--var clave=valor] [--secret NOMBRE=valor] [--continuar] [--json] [--junit informe.xml] [--timeout ms]';

export function leerArgumentos(argv: string[]): Opciones | string {
    const variables: Record<string, string> = {};
    const secretos: Record<string, string> = {};
    let fichero = '';
    let entorno: string | undefined;
    let continuar = false;
    let json = false;
    let junit: string | undefined;
    let timeoutMs = 30_000;

    const parClaveValor = (par: string, que: string): [string, string] | string => {
        const corte = par.indexOf('=');
        if (corte < 1) {
            return `${que} mal escrito: "${par}". Se espera clave=valor`;
        }
        return [par.slice(0, corte), par.slice(corte + 1)];
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--var' || a === '-v') {
            const r = parClaveValor(argv[++i] ?? '', 'variable');
            if (typeof r === 'string') {
                return r.replace('variable mal escrito', 'variable mal escrita');
            }
            variables[r[0]] = r[1];
        } else if (a === '--secret' || a === '-s') {
            const r = parClaveValor(argv[++i] ?? '', 'secreto');
            if (typeof r === 'string') {
                return r;
            }
            secretos[r[0]] = r[1];
        } else if (a === '--env' || a === '-e') {
            entorno = argv[++i];
            if (!entorno) {
                return '--env necesita el nombre de un entorno de http-client.env.json';
            }
        } else if (a === '--timeout') {
            timeoutMs = Number(argv[++i]);
            if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                return '--timeout necesita un número de milisegundos mayor que 0';
            }
        } else if (a === '--continuar') {
            continuar = true;
        } else if (a === '--json') {
            json = true;
        } else if (a === '--junit') {
            junit = argv[++i];
            if (!junit) {
                return '--junit necesita la ruta del informe XML';
            }
        } else if (!a.startsWith('-')) {
            fichero = a;
        }
    }
    if (!fichero) {
        return USO;
    }
    return { fichero, variables, secretos, entorno, continuar, json, timeoutMs, junit };
}

/** El bloque con `@name` = nombre, ya sea en el fichero o vía `run #nombre`. */
function soloElBloque(bloques: Bloque[], nombre: string): Bloque[] {
    const directo = bloques.find(b => b.nombre === nombre);
    if (directo) {
        return [directo];
    }
    return [{ texto: `run #${nombre}`, linea: 0 }];
}

/**
 * Variables de fichero: `@nombre = valor`, declaradas normalmente al principio
 * y válidas para todo el fichero. Se leen del texto completo, no del bloque,
 * porque así es como funcionan en el editor.
 */
export function variablesDeFichero(texto: string): Record<string, string> {
    const fuera: Record<string, string> = {};
    for (const m of texto.matchAll(/^\s*@([A-Za-z_][\w.-]*)\s*=\s*(.*)$/gm)) {
        fuera[m[1]] = m[2].trim();
    }
    return fuera;
}

/** Secretos: de la línea de órdenes, o de `HTTPKEEPER_SECRET_NOMBRE`. Faltar es un error, no un hueco. */
export function secreto(nombre: string, secretos: Record<string, string>): string {
    const valor = secretos[nombre] ?? process.env[`HTTPKEEPER_SECRET_${nombre}`];
    if (valor === undefined) {
        throw new Error(`falta el secreto "${nombre}": pásalo con --secret ${nombre}=valor o en la variable de entorno HTTPKEEPER_SECRET_${nombre}`);
    }
    return valor;
}

/**
 * Sustituye `{{variable}}` con lo dado en la línea de órdenes, el entorno y
 * las variables de sistema que tienen sentido fuera del editor. Las mismas
 * que en el editor, con los alias de JetBrains, para que un fichero se
 * comporte igual en los dos sitios.
 */
export function sustituir(texto: string, variables: Record<string, string>, secretos: Record<string, string> = {}): string {
    return texto.replace(/\{\{([^{}]+)\}\}/g, (completo, nombre: string) => {
        const clave = nombre.trim();
        if (clave in variables) {
            return variables[clave];
        }
        const [sistema, ...resto] = clave.split(/\s+/);
        const argumento = resto.join(' ');
        switch (sistema.replace(/\(.*$/, '')) {
            case '$processEnv': return process.env[argumento] ?? '';
            case '$faker': {
                const grupos = fakerRegex.exec(clave);
                if (!grupos) {
                    return completo;
                }
                const r = resolveFakerPath(faker, grupos[1], grupos[2]);
                return 'value' in r ? r.value : completo;
            }
            case '$secret': return secreto(argumento, secretos);
            case '$guid':
            case '$uuid': return crypto.randomUUID();
            case '$timestamp': return String(Math.floor(Date.now() / 1000));
            case '$isoTimestamp': return new Date().toISOString();
            case '$datetime': return argumento.startsWith('rfc1123') ? new Date().toUTCString() : new Date().toISOString();
            case '$randomInt': {
                const [min, max] = argumento.split(/\s+/).map(Number);
                return Number.isFinite(min) && Number.isFinite(max) && min < max ? String(min + Math.floor(Math.random() * (max - min))) : completo;
            }
            case '$random.integer': {
                const m = /\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/.exec(clave);
                if (!m) {
                    return completo;
                }
                const [min, max] = [Number(m[1]), Number(m[2])];
                return min < max ? String(min + Math.floor(Math.random() * (max - min))) : completo;
            }
            default: return completo;
        }
    });
}

export async function ejecutar(opciones: Opciones, salida: (linea: string) => void): Promise<number> {
    const ficheroAbs = path.resolve(opciones.fichero);
    const texto = fs.readFileSync(ficheroAbs, 'utf8');
    const raiz = path.dirname(ficheroAbs);
    const entorno = entornoTerminal(raiz, ficheroAbs);

    const { importados, faltan } = cerrarImportaciones(ficheroAbs, texto);
    for (const f of faltan) {
        entorno.avisar(`import: no existe ${f}`);
    }

    // Prioridad de menor a mayor: entorno de fichero -> @variables (importadas,
    // luego propias) -> --var. Lo de la línea de órdenes manda: es lo que
    // permite apuntar el mismo fichero a otro sitio desde el servidor de CI.
    const variables = {
        ...variablesDeEntorno(raiz, opciones.entorno, entorno.avisar),
        ...variablesConImportados(texto, importados),
        ...opciones.variables
    };

    const todos = trocear(texto).filter(esPeticion);
    const bloques = opciones.solo ? soloElBloque(todos, opciones.solo) : todos;
    const porBloque = new Map<number, Resultado[]>();
    // Lo que ya han devuelto las peticiones con nombre, para poder encadenar.
    const previas = new Map<string, { cuerpo: string; cabeceras: Record<string, string | undefined>; estado: number }>();

    const pasos = await ejecutarSecuencia(bloques, {
        continuarTrasFallo: opciones.continuar,
        resolver: async (b: Bloque) => {
            const real = resolverRun(b, texto, importados);
            return { ...real, texto: sustituir(resolverPrevias(real.texto, previas), variables, opciones.secretos) };
        },
        enviar: async (b: Bloque) => {
            const peticion = parsear(b.texto, raiz, t => sustituir(t, variables, opciones.secretos));
            const timeout = timeoutDelBloque(b.texto);
            const resultado = peticion.metodo === 'WEBSOCKET'
                ? await enviarWebSocket(peticion, timeout ?? MS_ESCUCHA_POR_DEFECTO)
                : await enviarPeticion(peticion, timeout ?? opciones.timeoutMs);
            if (b.nombre) {
                previas.set(b.nombre, resultado);
            }
            return resultado;
        },
    });

    let fallos = 0;
    pasos.forEach((paso, i) => {
        const resultados = paso.error
            ? []
            : comprobar(leerAserciones(bloques[i].texto), { estado: paso.estado, cuerpo: paso.cuerpo, cabeceras: paso.cabeceras, ms: paso.ms });
        porBloque.set(i, resultados);
        const malas = resultados.filter(r => !r.pasa);
        fallos += malas.length + (paso.error ? 1 : 0);

        if (!opciones.json) {
            const marca = paso.error ? 'ERROR' : malas.length ? 'FALLA' : '  ok ';
            salida(`${marca}  ${paso.nombre.padEnd(20)} ${String(paso.estado ?? '').padStart(3)}  ${paso.ms} ms`);
            for (const m of malas) {
                salida(`         ${m.asercion.crudo}   ->  ${recortar(m.obtenido)}`);
            }
            if (paso.error) {
                salida(`         ${paso.error}`);
            }
        }
    });

    if (opciones.junit) {
        fs.writeFileSync(opciones.junit, aJunit(path.basename(opciones.fichero), pasos.map((p, i) => ({
            nombre: p.nombre,
            ms: p.ms,
            error: p.error,
            fallos: (porBloque.get(i) ?? []).filter(r => !r.pasa).map(r => `${r.asercion.crudo} -> ${r.obtenido}`)
        }))));
    }

    if (opciones.json) {
        salida(JSON.stringify({
            fichero: opciones.fichero,
            pasos: pasos.map((p, i) => ({
                nombre: p.nombre, estado: p.estado, ms: p.ms, error: p.error,
                aserciones: (porBloque.get(i) ?? []).map(r => ({ asercion: r.asercion.crudo, pasa: r.pasa, obtenido: r.obtenido }))
            }))
        }, null, 2));
    } else {
        const total = pasos.length;
        salida('');
        salida(fallos === 0 ? `${total} peticiones, todo en verde` : `${total} peticiones, ${fallos} fallo(s)`);
    }
    return fallos === 0 ? 0 : 1;
}

/** Variables del entorno pedido, leídas de los http-client.env.json desde la carpeta del fichero hacia arriba. */
function variablesDeEntorno(raiz: string, nombre: string | undefined, avisar: (m: string) => void): Record<string, string> {
    if (!nombre) {
        return {};
    }
    const carpeta = carpetaDeEntornos(raiz);
    if (!carpeta) {
        avisar(`--env ${nombre}: no hay http-client.env.json desde ${raiz} hacia arriba`);
        return {};
    }
    const entornos = leerEntornos(carpeta, avisar);
    if (!(nombre in entornos)) {
        avisar(`--env ${nombre}: ese entorno no está en ${carpeta}. Hay: ${Object.keys(entornos).join(', ') || 'ninguno'}`);
        return {};
    }
    return entornos[nombre];
}

/** `# @timeout 5000` en el bloque manda sobre el --timeout general. */
export function timeoutDelBloque(texto: string): number | undefined {
    const m = /^\s*(?:#|\/\/)\s*@timeout\s+(\d+)\s*$/m.exec(texto);
    return m ? Number(m[1]) : undefined;
}

/** WebSocket: la «respuesta» es la transcripción, con estado 101 como en el editor. */
async function enviarWebSocket(p: { url: string; cabeceras: Record<string, string>; cuerpo?: string | Buffer }, ms: number):
    Promise<{ estado: number; cuerpo: string; cabeceras: Record<string, string | undefined> }> {
    const cuerpo = typeof p.cuerpo === 'string' ? p.cuerpo : p.cuerpo?.toString('utf8');
    const r = await hablar(p.url, p.cabeceras, mensajesDelCuerpo(cuerpo), ms);
    if (r.cerradoPor === 'error' && r.recibidos.length === 0) {
        throw new Error(r.detalle ?? 'WebSocket error');
    }
    return { estado: 101, cuerpo: r.transcripcion, cabeceras: { 'content-type': 'text/plain', 'x-closed-by': r.cerradoPor } };
}

/** Envía la petición con el cliente HTTP de Node: sin dependencias. */
function enviarPeticion(p: { metodo: string; url: string; cabeceras: Record<string, string>; cuerpo?: string | Buffer }, timeoutMs: number):
    Promise<{ estado: number; cuerpo: string; cabeceras: Record<string, string | undefined> }> {
    return new Promise((resolver, rechazar) => {
        let destino: URL;
        try {
            destino = new URL(p.url);
        } catch {
            rechazar(new Error(`URL no válida: ${p.url}`));
            return;
        }
        const transporte = destino.protocol === 'https:' ? https : http;
        const peticion = transporte.request(destino, { method: p.metodo, headers: p.cabeceras, timeout: timeoutMs }, respuesta => {
            const trozos: Buffer[] = [];
            const terminar = () => resolver({
                estado: respuesta.statusCode ?? 0,
                cuerpo: Buffer.concat(trozos).toString('utf8'),
                cabeceras: respuesta.headers as Record<string, string | undefined>
            });
            respuesta.on('data', t => trozos.push(t as Buffer));
            respuesta.on('end', terminar);
            // Un stream de eventos puede no terminar nunca: pasado el tiempo se
            // corta y lo recibido hasta entonces es la respuesta, no un error.
            if (esEventStream(respuesta.headers['content-type'])) {
                const corte = setTimeout(() => { respuesta.destroy(); terminar(); }, timeoutMs);
                respuesta.on('end', () => clearTimeout(corte));
            }
        });
        peticion.on('timeout', () => peticion.destroy(new Error(`sin respuesta en ${timeoutMs} ms`)));
        peticion.on('error', e => rechazar(e));
        if (p.cuerpo !== undefined) {
            if (!Object.keys(p.cabeceras).some(k => k.toLowerCase() === 'content-length')) {
                peticion.setHeader('Content-Length', Buffer.byteLength(p.cuerpo));
            }
            peticion.write(p.cuerpo);
        }
        peticion.end();
    });
}

/** Resuelve `{{nombre.response.body.$.x}}` con lo que ya respondió esa petición. */
function resolverPrevias(texto: string, previas: Map<string, { cuerpo: string; cabeceras: Record<string, string | undefined>; estado: number }>): string {
    return texto.replace(/\{\{(\w+)\.response\.(body|headers)\.([^{}]+)\}\}/g, (completo, nombre: string, parte: string, resto: string) => {
        const r = previas.get(nombre);
        if (!r) {
            return completo;
        }
        const sujeto = parte === 'headers' ? `headers.${resto.trim()}` : `body.${resto.trim()}`;
        // Se reutiliza el mismo resolutor que las aserciones: un solo lenguaje.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { valorDe } = require('../core/aserciones');
        const valor = valorDe(sujeto, { estado: r.estado, cuerpo: r.cuerpo, cabeceras: r.cabeceras, ms: 0 });
        return valor === '' ? completo : valor;
    });
}

const recortar = (s: string) => (s.length > 90 ? s.slice(0, 87) + '...' : s);

export { Importado };

if (require.main === module) {
    if (process.argv[2] === 'mcp') {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { servirMcp } = require('./mcp');
        const i = process.argv.indexOf('--raiz');
        servirMcp(i > 0 ? process.argv[i + 1] : process.cwd());
    } else {
        const opciones = leerArgumentos(process.argv.slice(2));
        if (typeof opciones === 'string') {
            process.stderr.write(opciones + '\n');
            process.exit(2);
        }
        ejecutar(opciones, l => process.stdout.write(l + '\n'))
            .then(codigo => process.exit(codigo))
            .catch(e => {
                process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
                process.exit(2);
            });
    }
}
