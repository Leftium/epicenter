import { AudioEncoderServiceLive } from './audio-encoder';
import { AutostartServiceLive } from './autostart';
import { CommandServiceLive } from './command';
import { FsServiceLive } from './fs';
import { GlobalShortcutManagerLive } from './global-shortcut-manager';
import { PermissionsServiceLive } from './permissions';
import { CpalRecorderServiceLive } from './recorder/cpal';
import { TrayIconServiceLive } from './tray';

/**
 * Desktop-only services.
 * These services are only available in the Tauri desktop app.
 */
export const desktopServices = {
	audioEncoder: AudioEncoderServiceLive,
	autostart: AutostartServiceLive,
	command: CommandServiceLive,
	fs: FsServiceLive,
	tray: TrayIconServiceLive,
	globalShortcutManager: GlobalShortcutManagerLive,
	permissions: PermissionsServiceLive,
	cpalRecorder: CpalRecorderServiceLive,
} as const;
