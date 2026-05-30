import { AnalyticsServiceLive } from '#platform/analytics';
import { AudioBlobStoreLive } from '#platform/blob-store';
import { DownloadServiceLive } from '#platform/download';
import { PlaySoundServiceLive } from '#platform/sound';
import { TextServiceLive } from '#platform/text';
import * as completions from './completion';
import { LocalShortcutManagerLive } from './local-shortcut-manager';

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
	sound: PlaySoundServiceLive,
} as const;
