/**
 * Web stub for a Tauri-only service. See `index.tauri.ts` for the real
 * implementation. Stub exists so static imports resolve at `vite build`
 * time; any call throws because web consumers gate on
 * `window.__TAURI_INTERNALS__`.
 */

function unreachable(): never {
	throw new Error('Tauri-only service called from web bundle');
}

export const FsError = {
	ReadFileFailed: unreachable,
	WriteFileFailed: unreachable,
} as unknown as typeof import('./index.tauri').FsError;

export const FsServiceLive = {
	pathToBlob: unreachable,
	pathsToFiles: unreachable,
} as unknown as typeof import('./index.tauri').FsServiceLive;
