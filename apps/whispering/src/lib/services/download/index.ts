import { isTauri } from '@tauri-apps/api/core';
import { createDownloadServiceDesktop } from './desktop';
import { createDownloadServiceWeb } from './web';

export type { DownloadError, DownloadService } from './types';

export const DownloadServiceLive = isTauri()
	? createDownloadServiceDesktop()
	: createDownloadServiceWeb();
