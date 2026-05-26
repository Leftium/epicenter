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

import { unreachable } from '$lib/services/_tauri-stub';
import type * as Tauri from './index.tauri';

export const FsError = {
	ReadBlobFailed: unreachable,
	ReadFileFailed: unreachable,
	ReadFilesFailed: unreachable,
} satisfies typeof Tauri.FsError;

export const FsServiceLive = {
	pathToBlob: unreachable,
	pathToFile: unreachable,
	pathsToFiles: unreachable,
} satisfies typeof Tauri.FsServiceLive;
