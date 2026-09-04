// Guion de la demo: se ejecuta DENTRO de VS Code (extensionTestsPath) y hace
// lo que haria una persona, con los comandos de verdad de la extension. No hay
// nada montado para la camara: las respuestas salen del servidor local que
// levanta lanzar.mjs.
//
// Cada plano deja la escena limpia antes de posar, escribe una senal en disco
// para que el capturador sepa como se llama el PNG, y espera.
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const SALIDA = process.env.DEMO_SALIDA;
const PUERTO = process.env.DEMO_PUERTO;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const senal = (nombre) => fs.writeFileSync(path.join(SALIDA, 'plano.txt'), nombre);

async function limpiar() {
    for (const c of [
        'workbench.action.closeAuxiliaryBar',
        'notifications.clearAll',
        'notifications.hideToasts',
        'workbench.action.closePanel',
    ]) {
        try { await vscode.commands.executeCommand(c); } catch { /* da igual si no aplica */ }
    }
}

async function abrir(fichero, columna = vscode.ViewColumn.One) {
    const uri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, fichero));
    const doc = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(doc, { viewColumn: columna, preview: false });
}

/** Deja el cursor en la peticion que empieza por `texto` y la envia. */
async function enviar(editor, texto) {
    const linea = editor.document.getText().split(/\r?\n/).findIndex((l) => l.startsWith(texto));
    if (linea < 0) throw new Error(`no encuentro la peticion "${texto}"`);
    const pos = new vscode.Position(linea, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    await espera(400);
    await vscode.commands.executeCommand('rest-client.request');
}

exports.run = async () => {
    await espera(2500);
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await limpiar();

    // --- 1. Una peticion y su respuesta, lado a lado -----------------------
    const api = await abrir('api.http');
    await espera(800);
    await enviar(api, 'POST {{host}}/entrar');
    await espera(3000);
    await limpiar();
    senal('01-send');
    await espera(3500);

    // --- 2. El valor de una respuesta alimenta la siguiente ----------------
    await vscode.window.showTextDocument(api.document, { viewColumn: vscode.ViewColumn.One });
    await enviar(api, 'GET {{host}}/facturas');
    await espera(3000);
    await limpiar();
    senal('02-chain');
    await espera(3500);

    // --- 3. Aserciones: el fichero .http dice lo que espera ----------------
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await espera(600);
    const pruebas = await abrir('pruebas.http');
    await espera(1200);
    await limpiar();
    senal('03-assertions');
    await espera(3000);

    // --- 4. El mismo fichero, corriendo en la terminal ---------------------
    const term = vscode.window.createTerminal({
        name: 'httpkeeper',
        cwd: vscode.workspace.workspaceFolders[0].uri.fsPath,
        env: { DEMO_PUERTO: PUERTO },
    });
    term.show(false);
    await espera(1200);
    term.sendText(`node "${process.env.DEMO_CLI}" pruebas.http`);
    await espera(6000);
    senal('04-runner');
    await espera(3500);

    // --- 5. Streaming: la respuesta de una API de modelos, evento a evento ----
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await espera(600);
    const chat = await abrir('chat.http');
    await espera(800);
    // Se señala ANTES de enviar: el plano bueno es el de mitad del stream.
    senal('05-stream');
    await enviar(chat, 'POST {{host}}/chat');
    await espera(7000);
    await limpiar();
    senal('06-stream-final');
    await espera(2000);

    fs.writeFileSync(path.join(SALIDA, 'fin.txt'), 'listo');
    await espera(1500);
};
