import { Event, EventEmitter, l10n } from 'vscode';
import * as Constants from '../common/constants';
import { EnvironmentController } from '../controllers/environmentController';
import { SystemSettings } from '../models/configurationSettings';

/**
 * The title of the Send Request CodeLens, in `.http` files and in Markdown.
 */
export async function sendRequestTitle(): Promise<string> {
    if (!SystemSettings.Instance.showEnvironmentInCodeLensTitle) {
        return l10n.t('Send Request');
    }
    const environment = await EnvironmentController.getCurrentEnvironment();
    return environment.name === Constants.NoEnvironmentSelectedName
        ? l10n.t('Send Request with no environment')
        : l10n.t('Send Request on {0}', environment.label);
}

let titleChanges: EventEmitter<void> | undefined;

/**
 * Define when to fire the title changes
 */
export function onDidChangeSendRequestTitle(): Event<void> {
    if (!titleChanges) {
        const emitter = new EventEmitter<void>();
        const settings = SystemSettings.Instance;
        let shown = settings.showEnvironmentInCodeLensTitle;
        EnvironmentController.onDidChangeEnvironment(() => {
            if (settings.showEnvironmentInCodeLensTitle) {
                emitter.fire();
            }
        });
        // Also fired on every change of editor: only a real switch refreshes.
        settings.onDidChangeConfiguration(() => {
            if (settings.showEnvironmentInCodeLensTitle !== shown) {
                shown = settings.showEnvironmentInCodeLensTitle;
                emitter.fire();
            }
        });
        titleChanges = emitter;
    }
    return titleChanges.event;
}
