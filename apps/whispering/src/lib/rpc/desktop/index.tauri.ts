import { autostart } from './autostart';
import { ffmpeg } from './ffmpeg';
import { globalShortcuts } from './shortcuts';
import { tray } from './tray';

/**
 * Desktop-only RPC namespace. Bundled only on Tauri builds via Vite's
 * suffix-based `resolve.extensions`. The web build resolves
 * `./index.browser.ts` instead, which exposes the same shape with
 * throwing stubs.
 */
export const desktopRpc = {
	autostart,
	tray,
	ffmpeg,
	globalShortcuts,
};
