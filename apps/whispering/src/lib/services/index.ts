import { AnalyticsServiceLive } from './analytics';
import { AudioBlobStoreLive } from './blob-store';
import * as completions from './completion';
import { DownloadServiceLive } from './download';
import { LocalShortcutManagerLive } from './local-shortcut-manager';
import { OsServiceLive } from './os';
import { NavigatorRecorderServiceLive } from './recorder/navigator';
import { PlaySoundServiceLive } from './sound';
import { TextServiceLive } from './text';
import * as transcriptions from './transcription';

/**
 * Cross-platform services.
 * These are available on both web and desktop.
 */
export const services = {
	analytics: AnalyticsServiceLive,
	text: TextServiceLive,
	completions,
	blobs: { audio: AudioBlobStoreLive },
	download: DownloadServiceLive,
	localShortcutManager: LocalShortcutManagerLive,
	navigatorRecorder: NavigatorRecorderServiceLive,
	os: OsServiceLive,
	sound: PlaySoundServiceLive,
	transcriptions,
} as const;
