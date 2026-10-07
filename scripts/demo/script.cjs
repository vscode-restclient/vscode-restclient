// The demo script: it runs INSIDE VS Code (extensionTestsPath) and does what
// a person would, with the extension's real commands. Nothing is staged for the
// camera: the responses come from the local server launch.mjs starts.
//
// Each shot clears the scene before posing, writes a signal to disk so the
// capturer knows what the PNG is called, and waits.
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const OUTPUT = process.env.DEMO_SALIDA;
const PORT = process.env.DEMO_PUERTO;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const signal = (name) => fs.writeFileSync(path.join(OUTPUT, 'plano.txt'), name);

async function clear() {
    for (const c of [
        'workbench.action.closeAuxiliaryBar',
        'notifications.clearAll',
        'notifications.hideToasts',
        'workbench.action.closePanel',
    ]) {
        try { await vscode.commands.executeCommand(c); } catch { /* fine if it does not apply */ }
    }
}

async function open(file, column = vscode.ViewColumn.One) {
    const uri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, file));
    const doc = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
}

/** Puts the cursor on the request that starts with `text` and sends it. */
async function send(editor, text) {
    const line = editor.document.getText().split(/\r?\n/).findIndex((l) => l.startsWith(text));
    if (line < 0) throw new Error(`cannot find the request "${text}"`);
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    await wait(400);
    await vscode.commands.executeCommand('rest-client.request');
}

exports.run = async () => {
    await wait(2500);
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await clear();

    // --- 1. A request and its response, side by side -----------------------
    const api = await open('api.http');
    await wait(800);
    await send(api, 'POST {{host}}/entrar');
    await wait(3000);
    await clear();
    signal('01-send');
    await wait(3500);

    // --- 2. A value from one response feeds the next -----------------------
    await vscode.window.showTextDocument(api.document, { viewColumn: vscode.ViewColumn.One });
    await send(api, 'GET {{host}}/facturas');
    await wait(3000);
    await clear();
    signal('02-chain');
    await wait(3500);

    // --- 3. Assertions: the .http file says what it expects ----------------
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await wait(600);
    const tests = await open('pruebas.http');
    await wait(1200);
    await clear();
    signal('03-assertions');
    await wait(3000);

    // --- 4. The same file, running in the terminal -------------------------
    const term = vscode.window.createTerminal({
        name: 'restclient',
        cwd: vscode.workspace.workspaceFolders[0].uri.fsPath,
        env: { DEMO_PUERTO: PORT },
    });
    term.show(false);
    await wait(1200);
    term.sendText(`node "${process.env.DEMO_CLI}" pruebas.http`);
    await wait(6000);
    signal('04-runner');
    await wait(3500);

    // --- 5. Streaming: the response of a model API, event by event ---------
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await wait(600);
    const chat = await open('chat.http');
    await wait(800);
    // Signalled BEFORE sending: the good shot is the one halfway through the stream.
    signal('05-stream');
    await send(chat, 'POST {{host}}/chat');
    await wait(7000);
    await clear();
    signal('06-stream-final');
    await wait(2000);

    fs.writeFileSync(path.join(OUTPUT, 'fin.txt'), 'listo');
    await wait(1500);
};
