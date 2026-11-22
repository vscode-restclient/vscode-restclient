import { EventEmitter, l10n, Memento, QuickPickItem, window } from 'vscode';
import * as Constants from '../common/constants';
import { hasOwnDataFolder, withdrawSelection, writeSelection } from '../core/dataLocation';
import Logger from '../logger';
import { SystemSettings } from '../models/configurationSettings';
import { dataLocation, localFolders } from '../utils/dataLocator';
import { fileEnvironments } from '../utils/editorEnvironments';
import { EnvironmentStatusEntry } from '../utils/environmentStatusBarEntry';
import { UserDataManager } from '../utils/userDataManager';

type EnvironmentPickItem = QuickPickItem & { name: string };

export class EnvironmentController {
    private static readonly noEnvironmentPickItem: EnvironmentPickItem = {
        label: 'No Environment',
        name: Constants.NoEnvironmentSelectedName,
        description: 'You can still use variables defined in the $shared environment'
    };

    public static readonly sharedEnvironmentName: string = '$shared';

    /** The selection lives in the window's workspace state: each window has its own (Huachao#1444). */
    private static readonly stateKey = 'rest-client.selectedEnvironment';

    private static state: Memento | undefined;

    private static readonly _onDidChangeEnvironment = new EventEmitter<string>();

    public static readonly onDidChangeEnvironment = EnvironmentController._onDidChangeEnvironment.event;

    private readonly settings: SystemSettings = SystemSettings.Instance;

    private environmentStatusEntry: EnvironmentStatusEntry;

    private currentEnvironment: EnvironmentPickItem;

    private constructor(initEnvironment: EnvironmentPickItem) {
        this.currentEnvironment = initEnvironment;
        this.environmentStatusEntry = new EnvironmentStatusEntry(initEnvironment.label);
    }

    /**
     * With no argument it asks; with a name it switches directly (the tests
     * and any automation use this). `''` goes back to «no environment».
     */
    public async switchEnvironment(name?: string) {
        const fromSettings = Object.keys(this.settings.environmentVariables)
            .filter(name => name !== EnvironmentController.sharedEnvironmentName);
        const fromFile = Object.keys(fileEnvironments());
        const names = [...new Set([...fromSettings, ...fromFile])];

        const userEnvironments: EnvironmentPickItem[] = names.map(name => ({
            name,
            label: name,
            description: [
                name === this.currentEnvironment.name ? '$(check)' : '',
                fromFile.includes(name) ? l10n.t('from http-client.env.json') : ''
            ].filter(Boolean).join(' ') || undefined
        }));

        const itemPickList: EnvironmentPickItem[] = [EnvironmentController.noEnvironmentPickItem, ...userEnvironments];

        let item: EnvironmentPickItem | undefined;
        if (name !== undefined) {
            item = name === '' ? EnvironmentController.noEnvironmentPickItem : userEnvironments.find(e => e.name === name);
            if (!item) {
                window.showWarningMessage(l10n.t('There is no environment named "{0}"', name));
                return;
            }
        } else {
            item = await window.showQuickPick(itemPickList, { placeHolder: l10n.t('Select Rest Client environment') });
            if (!item) {
                return;
            }
        }

        this.currentEnvironment = item;

        EnvironmentController._onDidChangeEnvironment.fire(item.label);
        this.environmentStatusEntry.update(item.label);

        await EnvironmentController.state?.update(EnvironmentController.stateKey, { name: item.name, label: item.label });
        // Choosing one is asking for it: every folder of the window gets it.
        EnvironmentController.shareSelection(true);
    }

    /**
     * In `workspace` mode the selection is also left in the workspace
     * folders' `.rest-client/environment.json`, where the terminal runner and
     * the MCP server look for it when no `--env` is given: in every folder
     * when `everywhere` (an explicit switch), otherwise only in those whose
     * `.rest-client/` this extension created, so opening a window creates
     * nothing. In any other mode it is removed from the open folders, so the
     * runner does not follow a selection the editor no longer keeps up to
     * date; a project that is not open keeps it until it is opened.
     */
    public static shareSelection(everywhere = false): void {
        const keep = dataLocation() === 'workspace';
        for (const folder of localFolders()) {
            if (keep && (everywhere || hasOwnDataFolder(folder))) {
                EnvironmentController.shareSelectionIn(folder);
            } else if (!keep) {
                withdrawSelection(folder);
            }
        }
    }

    /** Leaves the selection in one workspace folder, in `workspace` mode. */
    public static shareSelectionIn(folder: string): void {
        if (dataLocation() !== 'workspace') {
            return;
        }
        const selection = EnvironmentController.selected() ?? EnvironmentController.noEnvironmentPickItem;
        try {
            writeSelection(folder, { name: selection.name, label: selection.label });
        } catch (error) {
            Logger.error(`Could not write the selected environment in ${folder}:`, error);
        }
    }

    /**
     * `state` is the window's workspace state. A workspace with no selection
     * of its own takes, once, the one REST Client kept in
     * `~/.rest-client/environment.json`, which is never written again.
     */
    public static async create(state: Memento): Promise<EnvironmentController> {
        this.state = state;
        if (state.get(this.stateKey) === undefined) {
            const legacy = await UserDataManager.getLegacyEnvironment() as Partial<EnvironmentPickItem> | undefined;
            const inherited = legacy && typeof legacy.name === 'string' && typeof legacy.label === 'string'
                ? { name: legacy.name, label: legacy.label }
                : { name: this.noEnvironmentPickItem.name, label: this.noEnvironmentPickItem.label };
            await state.update(this.stateKey, inherited);
        }
        const environment = await this.getCurrentEnvironment();
        this.shareSelection();
        return new EnvironmentController(environment);
    }

    private static selected(): EnvironmentPickItem | undefined {
        const current = this.state?.get<Partial<EnvironmentPickItem>>(this.stateKey);
        return current && typeof current.name === 'string' && typeof current.label === 'string'
            ? { name: current.name, label: current.label }
            : undefined;
    }

    public static async getCurrentEnvironment(): Promise<EnvironmentPickItem> {
        const current = this.selected();
        return current && current.name !== this.noEnvironmentPickItem.name ? current : this.noEnvironmentPickItem;
    }

    public dispose() {
        this.environmentStatusEntry.dispose();
    }
}
