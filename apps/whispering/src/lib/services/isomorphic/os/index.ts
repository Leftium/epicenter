import { createOsServiceDesktop } from './desktop';
import { createOsServiceWeb } from './web';

export type { OsError, OsService } from './types';

export const OsServiceLive = window.__TAURI_INTERNALS__
	? createOsServiceDesktop()
	: createOsServiceWeb();
