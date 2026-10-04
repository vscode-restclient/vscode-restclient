import { l10n, Memento, SecretStorage, window } from 'vscode';

/**
 * `{{$secret NOMBRE}}`: el valor vive en el almacén de secretos de VS Code
 * (cifrado por el sistema operativo), nunca en el fichero `.http`. Así un
 * fichero de peticiones se puede commitear entero, que es lo que pedía #279.
 *
 * El almacén no sabe listar sus claves, así que los nombres se apuntan aparte
 * en el estado global; sólo los nombres, nunca los valores.
 */
export class SecretStore {
    private static almacen: SecretStorage | undefined;
    private static status: Memento | undefined;
    private static readonly NAMES_KEY = 'rest-client.secretNames';

    public static inicializar(almacen: SecretStorage, status: Memento) {
        this.almacen = almacen;
        this.status = status;
    }

    public static get ready(): boolean {
        return this.almacen !== undefined;
    }

    public static names(): string[] {
        return this.status?.get<string[]>(this.NAMES_KEY) ?? [];
    }

    public static async get(name: string): Promise<string | undefined> {
        return this.almacen?.get(this.key(name));
    }

    public static async set(name: string, value: string): Promise<void> {
        await this.almacen?.store(this.key(name), value);
        const names = new Set(this.names());
        names.add(name);
        await this.status?.update(this.NAMES_KEY, [...names].sort());
    }

    public static async borrar(name: string): Promise<void> {
        await this.almacen?.delete(this.key(name));
        await this.status?.update(this.NAMES_KEY, this.names().filter(n => n !== name));
    }

    /**
     * Pide el valor con un cuadro de contraseña y lo guarda. Es lo que pasa la
     * primera vez que una petición usa un secreto que aún no existe: en vez de
     * fallar, se pregunta.
     */
    public static async prompt(name: string): Promise<string | undefined> {
        const value = await window.showInputBox({
            prompt: l10n.t('Value for secret "{0}" (stored encrypted, never written to the file)', name),
            password: true,
            ignoreFocusOut: true,
        });
        if (value === undefined || value === '') {
            return undefined;
        }
        await this.set(name, value);
        return value;
    }

    public static isValidName(name: string): boolean {
        return /^[\w.-]+$/.test(name);
    }

    private static key(name: string): string {
        return `rest-client.secret.${name}`;
    }
}
