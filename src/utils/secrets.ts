import { l10n, Memento, SecretStorage, window } from 'vscode';

/**
 * `{{$secret NAME}}`: the value lives in VS Code's secret storage (encrypted
 * by the operating system), never in the `.http` file. That way a request file
 * can be committed whole, which is what #279 asked for.
 *
 * The storage cannot list its keys, so the names are tracked separately in
 * global state; only the names, never the values.
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
     * Asks for the value with a password box and stores it. This is what
     * happens the first time a request uses a secret that does not exist yet:
     * instead of failing, it asks.
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
