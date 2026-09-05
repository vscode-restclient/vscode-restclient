// Se ejecuta dentro de VS Code, contra la extension YA INSTALADA desde el
// .vsix. No hay extensionDevelopmentPath: si algo se quedo fuera del paquete,
// aqui se cae.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const ID = 'vscode-restclient.rest-client';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async () => {
    const ext = vscode.extensions.getExtension(ID);
    assert.ok(ext, `no esta instalada ${ID}`);
    await ext.activate();

    // 1. Los comandos que anuncia la ficha estan de verdad.
    const comandos = await vscode.commands.getCommands(true);
    for (const c of ['httpkeeper.request', 'httpkeeper.history', 'httpkeeper.switch-environment', 'httpkeeper._openDocumentLink']) {
        assert.ok(comandos.includes(c), `falta el comando ${c}`);
    }

    // 2. Los recursos del paquete existen dentro de lo instalado.
    for (const r of ['styles/httpkeeper.css', 'styles/reset.css', 'styles/vscode.css', 'webview/main.js', 'images/icon.png', 'dist/cli.js', 'l10n/bundle.l10n.es.json']) {
        assert.ok(fs.existsSync(path.join(ext.extensionPath, r)), `falta en el paquete: ${r}`);
    }

    // 3. Una peticion de verdad, de punta a punta, con la extension instalada.
    const carpeta = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const fichero = path.join(carpeta, 'prueba.http');
    fs.writeFileSync(fichero, [
        `@host = http://127.0.0.1:${process.env.VSIX_PUERTO}`,
        '',
        '# @name entrar',
        'POST {{host}}/entrar',
        'Content-Type: application/json',
        '',
        '{"usuario":"ana"}',
        '',
    ].join('\n'));

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fichero));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(new vscode.Position(3, 0), new vscode.Position(3, 0));
    await vscode.commands.executeCommand('httpkeeper.request');

    // La respuesta se pinta en un panel; se espera a que aparezca la pestana.
    let visto = false;
    for (let i = 0; i < 60 && !visto; i++) {
        await espera(250);
        visto = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .some((t) => /Response/i.test(t.label));
    }
    assert.ok(visto, 'la respuesta no llego a mostrarse');

    // 4. Y el idioma: arrancado en castellano, la barra de estado habla castellano.
    if (vscode.env.language.startsWith('es')) {
        assert.strictEqual(vscode.l10n.t('Send Request'), 'Enviar la petición', 'la traduccion no viaja en el paquete');
    }

    console.log('el paquete instalado funciona');
};
