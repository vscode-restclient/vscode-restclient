// Runs inside VS Code, against the extension ALREADY INSTALLED from the .vsix.
// There is no extensionDevelopmentPath: if something was left out of the
// package, it falls over here.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const ID = 'vscode-restclient.restclient';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

exports.run = async () => {
    const ext = vscode.extensions.getExtension(ID);
    assert.ok(ext, `${ID} is not installed`);
    await ext.activate();

    // 1. The commands the listing announces really exist.
    const commandIds = await vscode.commands.getCommands(true);
    for (const c of ['rest-client.request', 'rest-client.history', 'rest-client.switch-environment', 'vscode-restclient._openDocumentLink']) {
        assert.ok(commandIds.includes(c), `missing command ${c}`);
    }

    // 2. The package resources exist inside what was installed.
    for (const r of ['styles/rest-client.css', 'styles/reset.css', 'styles/vscode.css', 'webview/main.js', 'images/icon.png', 'dist/cli.js', 'l10n/bundle.l10n.es.json']) {
        assert.ok(fs.existsSync(path.join(ext.extensionPath, r)), `missing from the package: ${r}`);
    }

    // 3. A real request, end to end, with the installed extension.
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const file = path.join(folder, 'test.http');
    fs.writeFileSync(file, [
        `@host = http://127.0.0.1:${process.env.VSIX_PORT}`,
        '',
        '# @name entrar',
        'POST {{host}}/entrar',
        'Content-Type: application/json',
        '',
        '{"usuario":"ana"}',
        '',
    ].join('\n'));

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(new vscode.Position(3, 0), new vscode.Position(3, 0));
    await vscode.commands.executeCommand('rest-client.request');

    // The response is painted in a panel; wait for the tab to show up.
    let seen = false;
    for (let i = 0; i < 60 && !seen; i++) {
        await wait(250);
        seen = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .some((t) => /Response/i.test(t.label));
    }
    assert.ok(seen, 'the response never showed up');

    // 4. And the language: started in Spanish, the status bar speaks Spanish.
    if (vscode.env.language.startsWith('es')) {
        assert.strictEqual(vscode.l10n.t('Send Request'), 'Enviar la petición', 'the translation does not ship in the package');
    }

    console.log('the installed package works');
};
