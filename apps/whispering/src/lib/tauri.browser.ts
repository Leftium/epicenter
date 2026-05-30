/**
 * Web runtime: every Tauri capability is absent. The named `tauri` export
 * matches the shared platform check from `./tauri.tauri.ts` but is always
 * `null`. The Tauri impl is never resolved on web (the `tauri` condition is
 * inactive), so `@tauri-apps/*` stays out of the browser bundle.
 *
 * The `Tauri` type is re-exported (type-only, erased at build) so consumers
 * that `import type { Tauri } from '#platform/tauri'` resolve it under both
 * the web (`default`) and Tauri conditions.
 *
 * `tauriOnly` is intentionally absent: it is for `*.tauri.ts` files, which
 * import it directly from `./tauri.tauri`. Shared or web code reaching for it
 * fails the build instead of shipping a runtime assertion.
 */
import type { Tauri } from './tauri.tauri';

export type { Tauri };

export const tauri: Tauri | null = null;
