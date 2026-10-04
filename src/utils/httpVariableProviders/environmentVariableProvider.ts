import { TextDocument } from 'vscode';
import * as Constants from '../../common/constants';
import { EnvironmentController } from '../../controllers/environmentController';
import { SystemSettings } from '../../models/configurationSettings';
import { ResolveErrorMessage } from '../../models/httpVariableResolveResult';
import { VariableType } from '../../models/variableType';
import { fileEnvironments } from '../editorEnvironments';
import { HttpVariable, HttpVariableProvider } from './httpVariableProvider';

/**
 * Variables del entorno elegido. Vienen de dos sitios que se suman:
 *
 * - los ajustes (`rest-client.environmentVariables`, o los heredados de la
 *   sección antigua), como siempre;
 * - los ficheros `http-client.env.json` / `http-client.private.env.json` que
 *   haya junto al `.http` o más arriba, que es el formato de JetBrains.
 *
 * Para el mismo entorno y la misma variable manda el fichero: lo que está en
 * el repositorio es lo que ve todo el equipo. `$shared` se conserva.
 */
export class EnvironmentVariableProvider implements HttpVariableProvider {
    private static _instance: EnvironmentVariableProvider;

    private readonly _settings: SystemSettings = SystemSettings.Instance;

    public static get Instance(): EnvironmentVariableProvider {
        if (!this._instance) {
            this._instance = new EnvironmentVariableProvider();
        }

        return this._instance;
    }

    private constructor() {
    }

    public readonly type: VariableType = VariableType.Environment;

    public async has(name: string, document?: TextDocument): Promise<boolean> {
        const variables = await this.getAvailableVariables(document);
        return name in variables;
    }

    public async get(name: string, document?: TextDocument): Promise<HttpVariable> {
        const variables = await this.getAvailableVariables(document);
        if (!(name in variables)) {
            return { name, error: ResolveErrorMessage.EnvironmentVariableNotExist };
        }

        return { name, value: variables[name] };
    }

    public async getAll(document?: TextDocument): Promise<HttpVariable[]> {
        const variables = await this.getAvailableVariables(document);
        return Object.keys(variables).map(key => ({ name: key, value: variables[key] }));
    }

    private async getAvailableVariables(document?: TextDocument): Promise<{ [key: string]: string }> {
        let { name: environmentName } = await EnvironmentController.getCurrentEnvironment();
        const withoutEnvironment = environmentName === Constants.NoEnvironmentSelectedName;
        if (withoutEnvironment) {
            environmentName = EnvironmentController.sharedEnvironmentName;
        }
        const variables = this._settings.environmentVariables;
        // Copias: el mapeo de `{{$shared x}}` de abajo escribe sobre el objeto,
        // y el original escribía sobre los propios ajustes.
        const currentEnvironmentVariables = { ...(variables[environmentName] ?? {}) };
        const sharedEnvironmentVariables = { ...(variables[EnvironmentController.sharedEnvironmentName] ?? {}) };

        // Resolve mappings from shared environment
        this.mapEnvironmentVariables('shared', sharedEnvironmentVariables, sharedEnvironmentVariables);
        this.mapEnvironmentVariables('shared', currentEnvironmentVariables, sharedEnvironmentVariables);

        // Resolve mappings from current environment
        this.mapEnvironmentVariables(environmentName, currentEnvironmentVariables, currentEnvironmentVariables);

        const fromFile = withoutEnvironment ? {} : (fileEnvironments(document)[environmentName] ?? {});
        return { ...sharedEnvironmentVariables, ...currentEnvironmentVariables, ...fromFile };
    }

    private mapEnvironmentVariables(environment: string, current: { [key: string]: string }, shared: { [key: string]: string }) {
        for (const [key, value] of Object.entries(current)) {
            const variableRegex = new RegExp(`\\{{2}\\$${environment} (.+?)\\}{2}`);
            const match = variableRegex.exec(value);

            if (!match) {
                continue;
            }

            const referenceKey = match[1].trim();
            if (shared[referenceKey] === undefined) {
                continue;
            }

            current[key] = current[key]!.replace(variableRegex, shared[referenceKey]!);
        }
    }
}
