import { autostart } from './autostart';
import { ffmpeg } from './ffmpeg';
import { globalShortcuts } from './shortcuts';
import { tray } from './tray';

/**
 * Desktop-only RPC namespace.
 * These query operations are only available in the Tauri desktop app.
 * The individual modules handle platform checks internally via desktopServices.
 */
export const desktopRpc = {
	autostart,
	tray,
	ffmpeg,
	globalShortcuts,
};
