'use strict';

/*
 * The `{{$faker module.property [params]}}` logic shared by the editor and
 * the terminal runner, ported from rest-client-next (tutilus) with the same
 * semantics: the path navigates the `faker` object, parameters are separated
 * by spaces and become numbers when they parse as one.
 *
 * The editor loads the library lazily (dynamic import(): nothing is paid at
 * activation, only the first time a file actually resolves a $faker). The
 * runner bundles its own copy instead, because cli.js travels as a single
 * file to npm and to the GitHub release.
 */

/** `internet.email` -> value; an error when the path does not exist in faker. */
export function resolveFakerPath(faker: unknown, path: string, params?: string): { value: string } | { error: string } {
    const parts = path.split('.');
    let target: any = faker;
    for (const part of parts) {
        target = target?.[part];
        if (target === undefined || target === null) {
            return { error: `Faker method not found: ${path}` };
        }
    }
    try {
        if (typeof target === 'function') {
            const args = params
                ? params.trim().split(/\s+/).map(p => {
                    const n = Number(p);
                    return isNaN(n) ? p : n;
                })
                : [];
            return { value: String(target(...args)) };
        }
        return { value: String(target) };
    } catch (error) {
        return { error: `Faker error: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
}

/** The same pattern rest-client-next uses: `$faker <path> [params]`. */
export const fakerRegex = /\$faker\s+([\w.]+)(?:\s+(.*))?/;

let cached: unknown;

/** Lazy load with a cache. Only the English locale: the full package is ~2 MB heavier. */
export async function loadFaker(): Promise<unknown> {
    if (!cached) {
        const mod = await import(/* webpackChunkName: "faker" */ '@faker-js/faker/locale/en');
        cached = mod.faker;
    }
    return cached;
}
