import * as path from 'path';
import * as vscode from 'vscode';
import { resumenDePeticiones } from '../core/secuencia';
import { RequestController } from '../controllers/requestController';

/**
 * RestClient como herramienta de los agentes que viven en el editor.
 *
 * Dos vías, las dos con guarda porque los tipos de `vscode` son los de 1.81:
 *
 * - Herramientas de modelo de lenguaje (VS Code ≥ 1.95): Copilot Chat o
 *   cualquier participante puede listar las peticiones de un `.http` y enviar
 *   una. Enviar pide confirmación al usuario; listar no toca la red.
 * - Definición del servidor MCP (VS Code ≥ 1.101): el modo agente descubre
 *   `restclient mcp` sin que nadie configure nada, apuntando al runner que
 *   viaja dentro de la propia extensión.
 *
 * Un fichero fuera del espacio de trabajo se rechaza: el agente sólo ve el
 * proyecto que el usuario tiene abierto.
 */
export function registrarHerramientas(context: vscode.ExtensionContext, controller: RequestController) {
    const api = vscode as unknown as ApiLm;
    if (api.lm?.registerTool && api.LanguageModelToolResult && api.LanguageModelTextPart) {
        context.subscriptions.push(api.lm.registerTool('rest_client_list_requests', {
            invoke: async (opciones: { input: { file?: string } }) => {
                const uri = ficheroDelEspacio(opciones.input.file);
                const doc = await vscode.workspace.openTextDocument(uri);
                const requests = resumenDePeticiones(doc.getText()).map(r => ({ name: r.nombre, method: r.metodo, url: r.url, line: r.linea + 1 }));
                return new api.LanguageModelToolResult!([new api.LanguageModelTextPart!(JSON.stringify({ file: vscode.workspace.asRelativePath(uri), requests }, null, 2))]);
            },
        }));

        context.subscriptions.push(api.lm.registerTool('rest_client_send_request', {
            prepareInvocation: async (opciones: { input: { file?: string; name?: string } }) => {
                const uri = ficheroDelEspacio(opciones.input.file);
                const doc = await vscode.workspace.openTextDocument(uri);
                const lista = resumenDePeticiones(doc.getText());
                const objetivo = opciones.input.name ? lista.find(r => r.nombre === opciones.input.name) : lista[0];
                const que = objetivo ? `${objetivo.metodo} ${objetivo.url}` : (opciones.input.name ?? 'the first request');
                const fichero = vscode.workspace.asRelativePath(uri);
                return {
                    invocationMessage: vscode.l10n.t('Sending {0} from {1}', que, fichero),
                    confirmationMessages: {
                        title: vscode.l10n.t('Send HTTP request'),
                        message: new vscode.MarkdownString(vscode.l10n.t('Send **{0}** from `{1}`?', que, fichero)),
                    },
                };
            },
            invoke: async (opciones: { input: { file?: string; name?: string } }) => {
                const uri = ficheroDelEspacio(opciones.input.file);
                const r = await controller.enviarDesdeFichero(uri, opciones.input.name);
                const cuerpo = r.body.length > 60_000 ? r.body.slice(0, 60_000) + `\n… (${r.body.length - 60_000} more characters)` : r.body;
                const salida = {
                    status: r.statusCode,
                    statusText: r.statusMessage,
                    ms: r.timingPhases.total ?? 0,
                    headers: r.headers,
                    body: cuerpo,
                };
                return new api.LanguageModelToolResult!([new api.LanguageModelTextPart!(JSON.stringify(salida, null, 2))]);
            },
        }));
    }

    if (api.lm?.registerMcpServerDefinitionProvider && api.McpStdioServerDefinition) {
        const cli = context.asAbsolutePath(path.join('dist', 'cli.js'));
        context.subscriptions.push(api.lm.registerMcpServerDefinitionProvider('restclient.mcp', {
            provideMcpServerDefinitions: async () => {
                const raiz = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!raiz) {
                    return [];
                }
                // El propio ejecutable del editor hace de Node con ELECTRON_RUN_AS_NODE:
                // así no hace falta que haya un `node` en el PATH.
                return [new api.McpStdioServerDefinition!('RestClient', process.execPath, [cli, 'mcp', '--raiz', raiz], { ELECTRON_RUN_AS_NODE: '1' })];
            },
        }));
    }
}

/** Resuelve la ruta contra el espacio de trabajo y rechaza lo que quede fuera. */
export function ficheroDelEspacio(fichero: string | undefined): vscode.Uri {
    if (!fichero) {
        throw new Error('file is required');
    }
    const carpetas = vscode.workspace.workspaceFolders ?? [];
    const abs = path.isAbsolute(fichero) ? fichero : path.resolve(carpetas[0]?.uri.fsPath ?? process.cwd(), fichero);
    const dentro = carpetas.some(c => {
        const rel = path.relative(c.uri.fsPath, abs);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (!dentro) {
        throw new Error(`${fichero} is outside the workspace`);
    }
    return vscode.Uri.file(abs);
}

interface ApiLm {
    lm?: {
        registerTool?: (nombre: string, herramienta: unknown) => vscode.Disposable;
        registerMcpServerDefinitionProvider?: (id: string, proveedor: unknown) => vscode.Disposable;
    };
    LanguageModelToolResult?: new (partes: unknown[]) => unknown;
    LanguageModelTextPart?: new (texto: string) => unknown;
    McpStdioServerDefinition?: new (etiqueta: string, comando: string, args: string[], env?: Record<string, string>) => unknown;
}
