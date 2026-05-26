/**
 * Web runtime: every Tauri capability is absent. The default export
 * matches the shape of `./tauri.tauri.ts` but always returns `null`.
 *
 * Vite picks this file via `resolve.extensions` for web builds.
 * TypeScript resolves `import { tauri } from '$lib/tauri'` to the
 * `.tauri.ts` companion (via `moduleSuffixes`) so consumers see the
 * full `Tauri | null` type without this file needing to restate it.
 */
export const tauri = null;

/**
 * Web stub. Always throws; `.tauri.ts` consumers (the only legal callers)
 * are stripped from web bundles, so this should be unreachable. The throw
 * exists so that an accidental import from a shared module fails loudly
 * instead of silently producing `undefined`.
 */
export function requireTauri(): never {
	throw new Error('requireTauri() called outside Tauri runtime');
}
