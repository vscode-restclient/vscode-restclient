import * as path from 'path';
import * as vscode from 'vscode';
import { requestSummaries } from '../core/sequence';
import { RequestController } from '../controllers/requestController';

/**
 * RestClient as a tool for the agents that live in the editor.
 *
 * Two routes, both guarded because the `vscode` typings are those of 1.81:
 *
 * - Language model tools (VS Code >= 1.95): Copilot Chat or any participant
 *   can list the requests in a `.http` file and send one. Sending asks the
 *   user for confirmation; listing never touches the network.
 * - MCP server definition (VS Code >= 1.101): agent mode discovers
 *   `restclient mcp` with nobody configuring anything, pointing at the runner
 *   that ships inside the extension itself.
 *
 * A file outside the workspace is refused: the agent only sees the project
 * the user has open.
 */
export function registerTools(context: vscode.ExtensionContext, controller: RequestController) {
    const api = vscode as unknown as ApiLm;
    if (api.lm?.registerTool && api.LanguageModelToolResult && api.LanguageModelTextPart) {
        context.subscriptions.push(api.lm.registerTool('rest_client_list_requests', {
            invoke: async (options: { input: { file?: string } }) => {
                const uri = workspaceFile(options.input.file);
                const doc = await vscode.workspace.openTextDocument(uri);
                const requests = requestSummaries(doc.getText()).map(r => ({ name: r.name, method: r.method, url: r.url, line: r.line + 1 }));
                return new api.LanguageModelToolResult!([new api.LanguageModelTextPart!(JSON.stringify({ file: vscode.workspace.asRelativePath(uri), requests }, null, 2))]);
            },
        }));

        context.subscriptions.push(api.lm.registerTool('rest_client_send_request', {
            prepareInvocation: async (options: { input: { file?: string; name?: string } }) => {
                const uri = workspaceFile(options.input.file);
                const doc = await vscode.workspace.openTextDocument(uri);
                const list = requestSummaries(doc.getText());
                const target = options.input.name ? list.find(r => r.name === options.input.name) : list[0];
                const what = target ? `${target.method} ${target.url}` : (options.input.name ?? 'the first request');
                const file = vscode.workspace.asRelativePath(uri);
                return {
                    invocationMessage: vscode.l10n.t('Sending {0} from {1}', what, file),
                    confirmationMessages: {
                        title: vscode.l10n.t('Send HTTP request'),
                        message: new vscode.MarkdownString(vscode.l10n.t('Send **{0}** from `{1}`?', what, file)),
                    },
                };
            },
            invoke: async (options: { input: { file?: string; name?: string } }) => {
                const uri = workspaceFile(options.input.file);
                const r = await controller.sendFromFile(uri, options.input.name);
                const body = r.body.length > 60_000 ? r.body.slice(0, 60_000) + `\n… (${r.body.length - 60_000} more characters)` : r.body;
                const output = {
                    status: r.statusCode,
                    statusText: r.statusMessage,
                    ms: r.timingPhases.total ?? 0,
                    headers: r.headers,
                    body: body,
                };
                return new api.LanguageModelToolResult!([new api.LanguageModelTextPart!(JSON.stringify(output, null, 2))]);
            },
        }));
    }

    if (api.lm?.registerMcpServerDefinitionProvider && api.McpStdioServerDefinition) {
        const cli = context.asAbsolutePath(path.join('dist', 'cli.js'));
        context.subscriptions.push(api.lm.registerMcpServerDefinitionProvider('restclient.mcp', {
            provideMcpServerDefinitions: async () => {
                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (!root) {
                    return [];
                }
                // The editor's own executable acts as Node via ELECTRON_RUN_AS_NODE,
                // so there is no need for a `node` on the PATH.
                return [new api.McpStdioServerDefinition!('RestClient', process.execPath, [cli, 'mcp', '--root', root], { ELECTRON_RUN_AS_NODE: '1' })];
            },
        }));
    }
}

/** Resolves the path against the workspace and refuses anything that falls outside it. */
export function workspaceFile(file: string | undefined): vscode.Uri {
    if (!file) {
        throw new Error('file is required');
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const abs = path.isAbsolute(file) ? file : path.resolve(folders[0]?.uri.fsPath ?? process.cwd(), file);
    const inside = folders.some(c => {
        const rel = path.relative(c.uri.fsPath, abs);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (!inside) {
        throw new Error(`${file} is outside the workspace`);
    }
    return vscode.Uri.file(abs);
}

interface ApiLm {
    lm?: {
        registerTool?: (name: string, tool: unknown) => vscode.Disposable;
        registerMcpServerDefinitionProvider?: (id: string, provider: unknown) => vscode.Disposable;
    };
    LanguageModelToolResult?: new (parts: unknown[]) => unknown;
    LanguageModelTextPart?: new (text: string) => unknown;
    McpStdioServerDefinition?: new (label: string, command: string, args: string[], env?: Record<string, string>) => unknown;
}
