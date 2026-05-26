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
