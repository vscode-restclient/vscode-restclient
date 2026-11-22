import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    dataLocationOf, editorSelection, folderDataPaths, hasOwnDataFolder, homeDataPaths, isHomeFolder, NO_ENVIRONMENT, prepareFolder,
    samePath, withdrawSelection, WORKSPACE_DATA_FOLDER, workspaceDataPaths, writeSelection
} from '../../core/dataLocation';

// P-97: where history, cookies and saved responses live (`home`, `workspace`,
// `shared`), and the editor's selection that the runner finds in `workspace` mode.
describe('data location', () => {
    let tmp: string;
    beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-data-')); });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it('P-97 · an unknown or missing value is home: nobody loses their data to a typo', () => {
        assert.strictEqual(dataLocationOf('workspace'), 'workspace');
        assert.strictEqual(dataLocationOf('shared'), 'shared');
        for (const value of [undefined, null, '', 'project', 'Workspace', 3]) {
            assert.strictEqual(dataLocationOf(value), 'home', String(value));
        }
    });

    it('P-97 · home is ~/.rest-client or VSC_REST_CLIENT_HOME; the XDG folders only when it does not exist', () => {
        assert.deepStrictEqual(homeDataPaths({}, tmp), { cache: path.join(tmp, '.rest-client'), state: path.join(tmp, '.rest-client') });
        const xdg = { XDG_CACHE_HOME: path.join(tmp, 'cache'), XDG_STATE_HOME: path.join(tmp, 'state') };
        assert.deepStrictEqual(homeDataPaths(xdg, tmp), { cache: path.join(tmp, 'cache', 'rest-client'), state: path.join(tmp, 'state', 'rest-client') });
        fs.mkdirSync(path.join(tmp, '.rest-client'));
        assert.deepStrictEqual(homeDataPaths(xdg, tmp), { cache: path.join(tmp, '.rest-client'), state: path.join(tmp, '.rest-client') });
        const own = path.join(tmp, 'own');
        assert.deepStrictEqual(homeDataPaths({ VSC_REST_CLIENT_HOME: own }, tmp), { cache: own, state: own });
    });

    it('P-97 · workspace is .rest-client in the folder, inside a project; shared is the folder given', () => {
        assert.deepStrictEqual(workspaceDataPaths(tmp), { cache: path.join(tmp, WORKSPACE_DATA_FOLDER), state: path.join(tmp, WORKSPACE_DATA_FOLDER), insideProject: true });
        assert.deepStrictEqual(folderDataPaths(tmp), { cache: tmp, state: tmp });
    });

    it('P-97 · a folder inside a project gets a .gitignore that ignores everything, and one already there is kept', () => {
        const inside = path.join(tmp, 'a', WORKSPACE_DATA_FOLDER);
        prepareFolder(inside, true);
        const ignore = fs.readFileSync(path.join(inside, '.gitignore'), 'utf8');
        assert.ok(ignore.split('\n').includes('*'), ignore);
        fs.writeFileSync(path.join(inside, '.gitignore'), 'mine');
        prepareFolder(inside, true);
        assert.strictEqual(fs.readFileSync(path.join(inside, '.gitignore'), 'utf8'), 'mine');
        const outside = path.join(tmp, 'b');
        prepareFolder(outside);
        assert.ok(fs.existsSync(outside) && !fs.existsSync(path.join(outside, '.gitignore')));
    });

    it('P-97 · the runner finds the editor\'s selection walking up from the file, and not above the ceiling', () => {
        const project = path.join(tmp, 'project');
        const deep = path.join(project, 'api', 'v1');
        fs.mkdirSync(deep, { recursive: true });
        assert.strictEqual(editorSelection(deep), undefined);
        writeSelection(project, { name: 'prod', label: 'prod' });
        assert.deepStrictEqual(editorSelection(deep), { name: 'prod', file: path.join(project, WORKSPACE_DATA_FOLDER, 'environment.json') });
        assert.ok(fs.existsSync(path.join(project, WORKSPACE_DATA_FOLDER, '.gitignore')), 'writing the selection also creates the .gitignore');
        assert.strictEqual(editorSelection(deep, path.join(project, 'api')), undefined, 'the MCP server does not look above its root');
    });

    it('P-97 · the shared file REST Client kept in ~/.rest-client is not the editor\'s selection for a project below it', () => {
        // The home folder is above every project in it, with a file of the same name.
        const home = path.join(tmp, WORKSPACE_DATA_FOLDER);
        fs.mkdirSync(home);
        fs.writeFileSync(path.join(home, 'environment.json'), JSON.stringify({ name: 'from-home', label: 'from-home' }));
        const project = path.join(tmp, 'code', 'project');
        fs.mkdirSync(project, { recursive: true });
        assert.strictEqual(editorSelection(project), undefined);
        writeSelection(path.join(tmp, 'code'), { name: 'prod', label: 'prod' });
        assert.strictEqual(editorSelection(project)?.name, 'prod');
    });

    it('P-97 · «no environment» in the editor is no environment for the runner, even with a selection further up', () => {
        const parent = path.join(tmp, 'parent');
        const child = path.join(parent, 'child');
        fs.mkdirSync(child, { recursive: true });
        writeSelection(parent, { name: 'prod', label: 'prod' });
        writeSelection(child, { name: NO_ENVIRONMENT, label: 'No Environment' });
        assert.deepStrictEqual(editorSelection(child), { name: undefined, file: path.join(child, WORKSPACE_DATA_FOLDER, 'environment.json') });
        fs.writeFileSync(path.join(child, WORKSPACE_DATA_FOLDER, 'environment.json'), '{ not json');
        assert.strictEqual(editorSelection(child), undefined, 'a broken file stops the search too');
    });

    it('P-97 · the home folder is never a project: nothing is written to its .rest-client, and a selection there is not followed', () => {
        const home = path.join(tmp, 'home');
        const project = path.join(home, 'code', 'project');
        fs.mkdirSync(project, { recursive: true });
        assert.strictEqual(isHomeFolder(home, home), true);
        writeSelection(home, { name: 'prod', label: 'prod' }, home);
        assert.ok(!fs.existsSync(path.join(home, WORKSPACE_DATA_FOLDER)), 'the home folder opened as a workspace gets nothing');
        // Even a marked file there (written by hand, or by an older build) is passed over.
        fs.mkdirSync(path.join(home, WORKSPACE_DATA_FOLDER));
        fs.writeFileSync(path.join(home, WORKSPACE_DATA_FOLDER, 'environment.json'), JSON.stringify({ name: 'prod', label: 'prod', scope: 'workspace' }));
        assert.strictEqual(editorSelection(project, undefined, home), undefined);
    });

    it('P-97 · leaving workspace mode withdraws the selection the editor left, and only that', () => {
        writeSelection(tmp, { name: 'prod', label: 'prod' });
        const data = path.join(tmp, WORKSPACE_DATA_FOLDER);
        fs.writeFileSync(path.join(data, 'history.json'), '[]');
        withdrawSelection(tmp);
        assert.ok(!fs.existsSync(path.join(data, 'environment.json')), 'the marked file is gone');
        assert.strictEqual(editorSelection(tmp), undefined);
        assert.ok(fs.existsSync(path.join(data, 'history.json')) && fs.existsSync(path.join(data, '.gitignore')), 'the data stays');
        fs.writeFileSync(path.join(data, 'environment.json'), JSON.stringify({ name: 'mine', label: 'mine' }));
        withdrawSelection(tmp);
        assert.ok(fs.existsSync(path.join(data, 'environment.json')), 'a file without the mark is not ours');
    });

    it('P-97 · a .rest-client/ that a repository keeps for something else is not taken for ours', () => {
        assert.strictEqual(hasOwnDataFolder(tmp), false);
        fs.mkdirSync(path.join(tmp, WORKSPACE_DATA_FOLDER));
        fs.writeFileSync(path.join(tmp, WORKSPACE_DATA_FOLDER, '.gitignore'), 'node_modules');
        assert.strictEqual(hasOwnDataFolder(tmp), false);
        const project = path.join(tmp, 'project');
        prepareFolder(path.join(project, WORKSPACE_DATA_FOLDER), true);
        assert.strictEqual(hasOwnDataFolder(project), true);
    });

    it('P-97 · the ceiling holds whatever the case on Windows and macOS, and Linux tells the cases apart', () => {
        const project = path.join(tmp, 'project');
        const deep = path.join(project, 'api');
        fs.mkdirSync(deep, { recursive: true });
        writeSelection(tmp, { name: 'prod', label: 'prod' });
        assert.strictEqual(editorSelection(deep, project), undefined, 'the ceiling as given');
        if (process.platform === 'win32' || process.platform === 'darwin') {
            assert.strictEqual(samePath(project.toUpperCase(), project.toLowerCase()), true);
            assert.strictEqual(editorSelection(deep, project.toUpperCase()), undefined);
            assert.strictEqual(editorSelection(deep.toLowerCase(), project.toUpperCase()), undefined);
        } else {
            // There `Project` and `project` are two folders, so they must not be one ceiling.
            assert.strictEqual(samePath(project.toUpperCase(), project.toLowerCase()), false);
        }
    });
});
