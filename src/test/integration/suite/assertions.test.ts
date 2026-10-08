import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const PORT = process.env.RC_TEST_PORT!;
const BASE = `http://[::1]:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const setting = (key: string, value: unknown) =>
  vscode.workspace.getConfiguration('rest-client').update(key, value, vscode.ConfigurationTarget.Global);

/** Opens a .http document, runs Send Request and returns the response document that carries `mark`. */
async function send(content: string, mark: string, seconds = 20): Promise<string> {
  const doc = await vscode.workspace.openTextDocument({ language: 'http', content });
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand('rest-client.request');
  for (let i = 0; i < seconds * 4; i++) {
    await wait(250);
    const response = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() !== doc.uri.toString() && d.getText().includes(mark),
    );
    if (response) return response.getText();
  }
  const open = vscode.workspace.textDocuments.map((d) => `${d.languageId}:${d.getText().slice(0, 80)}`).join(' | ');
  throw new Error(`no response with "${mark}" in ${seconds} s. Documents: ${open}`);
}

// #34: Send Request used to ignore the `# @assert` lines; only the runner
// checked them. Now the verdict shows under the response.
describe('Rest Client · assertions in the editor', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('vscode-restclient.restclient');
    assert.ok(ext, 'the extension is not loaded');
    await ext!.activate();
    await setting('previewResponseInUntitledDocument', true);
    await setting('previewOption', undefined);
  });

  after(async () => {
    await setting('previewOption', undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('P-84 · the verdict of every @assert line is shown under the response, with the actual value for a failure', async () => {
    const t = await send([
      `GET ${BASE}/json`,
      '',
      '# @assert status == 200',
      '# @assert body.$.nested.a == 1',
      '# @assert header.content-type contains json',
      '# @assert body.$.nested.a == 2',
      '# @assert time < 60000',
      '',
    ].join('\n'), 'assertions passed');
    assert.ok(t.includes('HTTP/1.1 200'), `no 200 in:\n${t.slice(0, 300)}`);
    assert.ok(t.includes('# 4 of 5 assertions passed'), `no summary in:\n${t.slice(-400)}`);
    assert.ok(t.includes('# OK    status == 200'), 'the passing assertion is not reported');
    assert.ok(t.includes('# FAIL  body.$.nested.a == 2   ->  1'), `the failure does not show the actual value:\n${t.slice(-400)}`);
    // The verdict comes after the body, as comments, and the body is untouched.
    assert.ok(t.indexOf('"nested"') < t.indexOf('# 4 of 5 assertions passed'), 'the verdict must come after the body');
  });

  it('P-85 · a request without @assert lines shows nothing about assertions', async () => {
    const t = await send(`GET ${BASE}/json?no-assert\n`, '/json?no-assert');
    assert.ok(t.includes('HTTP/1.1 200'), `no 200 in:\n${t.slice(0, 300)}`);
    assert.ok(!/assertions passed|^# (OK|FAIL) /m.test(t), `an unexpected verdict:\n${t.slice(-300)}`);
  });

  it('P-86 · in body-only preview the document is the body and carries no verdict', async () => {
    await setting('previewOption', 'body');
    try {
      const t = await send([
        `GET ${BASE}/echo/body-only`,
        '',
        '# @assert status == 200',
        '',
      ].join('\n'), '/echo/body-only');
      assert.ok(!t.includes('assertions passed'), `the body-only document must stay the body:\n${t}`);
      assert.doesNotThrow(() => JSON.parse(t), 'the body-only document must still be valid JSON');
    } finally {
      await setting('previewOption', undefined);
    }
  });

  it('P-87 · a `run #name` block keeps its own @assert lines, as in the runner', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(folder, 'the test needs an open workspace');
    const file = path.join(folder!, 'run-assert.http');
    fs.writeFileSync(file, [
      '# @name status',
      `GET ${BASE}/status/201`,
      '',
      '###',
      '',
      'run #status',
      '',
      '# @assert status == 201',
      '# @assert status == 200',
      '',
    ].join('\n'));
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const line = doc.getText().split('\n').findIndex((l) => l.startsWith('run #status'));
    editor.selection = new vscode.Selection(new vscode.Position(line, 0), new vscode.Position(line, 0));
    await vscode.commands.executeCommand('rest-client.request');
    let t = '';
    for (let i = 0; i < 80 && !t; i++) {
      await wait(250);
      t = vscode.workspace.textDocuments.find((d) => d.getText().includes('# 1 of 2 assertions passed'))?.getText() ?? '';
    }
    assert.ok(t.includes('# OK    status == 201'), `the run block's assertions were not checked:\n${t.slice(-400)}`);
    assert.ok(t.includes('# FAIL  status == 200   ->  201'), `the failing one is not reported:\n${t.slice(-400)}`);
  });
});
