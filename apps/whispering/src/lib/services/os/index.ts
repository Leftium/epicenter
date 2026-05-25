import { isTauri } from '@tauri-apps/api/core';
import { createOsServiceDesktop } from './desktop';
import { createOsServiceWeb } from './web';

export type { OsError, OsService } from './types';

export const OsServiceLive = isTauri()
	? createOsServiceDesktop()
	: createOsServiceWeb();
