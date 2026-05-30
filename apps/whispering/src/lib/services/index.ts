import { AnalyticsServiceLive } from '#platform/analytics';
import { AudioBlobStoreLive } from '#platform/blob-store';
import * as completions from './completion';
import { DownloadServiceLive } from '#platform/download';
import { LocalShortcutManagerLive } from './local-shortcut-manager';
import { OsServiceLive } from '#platform/os';
import { PlaySoundServiceLive } from '#platform/sound';
import { TextServiceLive } from '#platform/text';
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
	os: OsServiceLive,
	sound: PlaySoundServiceLive,
	transcriptions,
} as const;
