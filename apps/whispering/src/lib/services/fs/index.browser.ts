/**
 * Web stub. The file-drop handler in `routes/(app)/+page.svelte` dynamic-
 * imports this path; Vite needs the path to resolve at chunk-generation
 * time even though the handler is gated by `window.__TAURI_INTERNALS__`
 * and the chunk is never loaded on web.
 *
 * The other Tauri-only services (autostart, command, ffmpeg, tray,
 * global-shortcut-manager, permissions) no longer have web stubs
 * because their consumers go through the consolidated stub at
 * `$lib/rpc/desktop/index.browser.ts` instead.
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
