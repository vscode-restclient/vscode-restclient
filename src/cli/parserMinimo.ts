/**
 * Parser del formato `.http` para la terminal.
 *
 * El parser del editor resuelve además variables, entornos y variables de
 * sistema, y para eso depende de los proveedores de VS Code: usarlo aquí
 * arrastraría medio editor. El runner ya trae las variables resueltas cuando
 * llega a este punto, así que sólo hace falta leer la petición.
 *
 * Cubre método, URL, cabeceras, cuerpo en línea, cuerpo desde fichero con
 * `< ruta` (también dentro de un multiparte, con `<@ ruta` para que se
 * sustituyan las variables del fichero) y una orden `curl` pegada.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface PeticionMinima {
    metodo: string;
    url: string;
    cabeceras: Record<string, string>;
    cuerpo?: string | Buffer;
}

const METODOS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'QUERY', 'WEBSOCKET'];
const SALTOS = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));
const FICHERO_EN_CUERPO = /^<(@)?\s+(.+?)\s*$/;

export function parsear(texto: string, base: string, sustituir: (t: string) => string = t => t): PeticionMinima {
    const lineas = texto.split(SALTOS);
    let i = 0;

    // Comentarios, metadatos y líneas en blanco antes de la petición.
    while (i < lineas.length && (lineas[i].trim() === '' || /^\s*(#|\/\/)/.test(lineas[i]) || /^\s*@[\w.-]+\s*=/.test(lineas[i]) || /^\s*import\s+\S/.test(lineas[i]))) {
        i++;
    }
    if (i >= lineas.length) {
        throw new Error('no hay ninguna petición en este bloque');
    }

    if (/^\s*curl\b/.test(lineas[i])) {
        return parsearCurl(lineas.slice(i), base);
    }

    const primera = lineas[i++].trim();
    const partes = primera.split(/\s+/);
    let metodo = 'GET';
    let url: string;
    if (METODOS.includes(partes[0].toUpperCase())) {
        metodo = partes[0].toUpperCase();
        url = partes[1] ?? '';
    } else {
        url = partes[0];
    }
    if (!url) {
        throw new Error(`no encuentro la URL en "${primera}"`);
    }

    // Una URL puede seguir en las líneas siguientes si empiezan por ? o &.
    while (i < lineas.length && /^\s*[?&]/.test(lineas[i])) {
        url += lineas[i++].trim();
    }

    const cabeceras: Record<string, string> = {};
    while (i < lineas.length && lineas[i].trim() !== '') {
        const l = lineas[i++];
        if (/^\s*(#|\/\/)/.test(l)) {
            continue;
        }
        const corte = l.indexOf(':');
        if (corte > 0) {
            cabeceras[l.slice(0, corte).trim()] = l.slice(corte + 1).trim();
        }
    }

    // Todo lo que sigue a la línea en blanco es el cuerpo, menos los comentarios
    // de metadatos (@assert, @name, @timeout) que van al final del bloque.
    const restantes = lineas.slice(i + 1).filter(l => !/^\s*(?:#|\/\/)\s*@(assert|name|timeout)\b/.test(l));
    const cuerpo = leerCuerpo(restantes, cabeceras, base, sustituir);
    return { metodo, url, cabeceras, cuerpo };
}

const tipoDe = (cabeceras: Record<string, string>) =>
    Object.entries(cabeceras).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';

/**
 * El cuerpo. Si alguna línea es `< fichero` se compone como bytes: el fichero
 * entra tal cual (o con variables sustituidas si es `<@ fichero`) y, en un
 * multiparte, los saltos son CRLF y hay uno final, que es lo que el servidor
 * espera para leer el último límite.
 */
function leerCuerpo(lineas: string[], cabeceras: Record<string, string>, base: string, sustituir: (t: string) => string): string | Buffer | undefined {
    // Sin ficheros: texto tal cual, recortado.
    if (!lineas.some(l => FICHERO_EN_CUERPO.test(l))) {
        const texto = lineas.join('\n').trim();
        return texto === '' ? undefined : texto;
    }
    const multiparte = /multipart\//i.test(tipoDe(cabeceras));
    const salto = Buffer.from(multiparte ? '\r\n' : '\n');
    // Las líneas en blanco de los extremos no son cuerpo.
    while (lineas.length && lineas[0].trim() === '') { lineas.shift(); }
    while (lineas.length && lineas[lineas.length - 1].trim() === '') { lineas.pop(); }
    const partes: Buffer[] = [];
    lineas.forEach((l, k) => {
        const m = FICHERO_EN_CUERPO.exec(l);
        if (m) {
            const ruta = path.isAbsolute(m[2]) ? m[2] : path.join(base, m[2]);
            if (!fs.existsSync(ruta)) {
                throw new Error(`no existe el fichero del cuerpo: ${m[2]}`);
            }
            partes.push(m[1] ? Buffer.from(sustituir(fs.readFileSync(ruta, 'utf8')), 'utf8') : fs.readFileSync(ruta));
        } else {
            partes.push(Buffer.from(l, 'utf8'));
        }
        if (k < lineas.length - 1 || multiparte) {
            partes.push(salto);
        }
    });
    return Buffer.concat(partes);
}

/**
 * Una orden `curl` pegada: `-X`, `-H`, `-d`/`--data*`, `-u`, `--url`, y las
 * continuaciones con `\` al final de línea. Lo que curl haría con eso es lo
 * que se envía.
 */
export function parsearCurl(lineas: string[], base: string): PeticionMinima {
    const unaLinea = lineas.join('\n').replace(/\\\r?\n/g, ' ').replace(/^\s*curl\b/, '');
    const args = trocearArgumentos(unaLinea);
    let metodo: string | undefined;
    let url = '';
    const cabeceras: Record<string, string> = {};
    const datos: string[] = [];
    let usuario: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const valor = () => args[++i] ?? '';
        if (a === '-X' || a === '--request') { metodo = valor().toUpperCase(); }
        else if (a.startsWith('-X') && a.length > 2) { metodo = a.slice(2).toUpperCase(); }
        else if (a === '-H' || a === '--header') {
            const h = valor();
            const corte = h.indexOf(':');
            if (corte > 0) { cabeceras[h.slice(0, corte).trim()] = h.slice(corte + 1).trim(); }
        }
        else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary' || a === '--data-ascii') { datos.push(valor()); }
        else if (a === '-u' || a === '--user') { usuario = valor(); }
        else if (a === '--url') { url = valor(); }
        else if (a === '-I' || a === '--head') { metodo = 'HEAD'; }
        else if (a === '-L' || a === '--location' || a === '--compressed' || a === '-s' || a === '-k' || a === '--insecure' || a === '-i') { /* sin efecto aquí */ }
        else if (!a.startsWith('-') && !url) { url = a; }
    }
    if (!url) {
        throw new Error('la orden curl no lleva URL');
    }
    let cuerpo: string | undefined = datos.length ? datos.join('&') : undefined;
    if (cuerpo?.startsWith('@')) {
        const ruta = path.isAbsolute(cuerpo.slice(1)) ? cuerpo.slice(1) : path.join(base, cuerpo.slice(1));
        if (!fs.existsSync(ruta)) {
            throw new Error(`no existe el fichero del cuerpo: ${cuerpo.slice(1)}`);
        }
        cuerpo = fs.readFileSync(ruta, 'utf8');
    }
    if (cuerpo !== undefined && !tipoDe(cabeceras)) {
        cabeceras['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (usuario && !Object.keys(cabeceras).some(k => k.toLowerCase() === 'authorization')) {
        cabeceras['Authorization'] = `Basic ${Buffer.from(usuario, 'utf8').toString('base64')}`;
    }
    return { metodo: metodo ?? (cuerpo !== undefined ? 'POST' : 'GET'), url, cabeceras, cuerpo };
}

/** Argumentos como los vería el shell: comillas simples y dobles, espacios dentro de ellas. */
export function trocearArgumentos(texto: string): string[] {
    const fuera: string[] = [];
    let actual = '';
    let dentro: '"' | "'" | null = null;
    let hayAlgo = false;
    for (let i = 0; i < texto.length; i++) {
        const c = texto[i];
        if (dentro) {
            if (c === dentro) { dentro = null; }
            else if (c === '\\' && dentro === '"' && i + 1 < texto.length) { actual += texto[++i]; }
            else { actual += c; }
        } else if (c === '"' || c === "'") {
            dentro = c;
            hayAlgo = true;
        } else if (/\s/.test(c)) {
            if (hayAlgo) { fuera.push(actual); actual = ''; hayAlgo = false; }
        } else {
            actual += c;
            hayAlgo = true;
        }
    }
    if (hayAlgo) {
        fuera.push(actual);
    }
    return fuera;
}
