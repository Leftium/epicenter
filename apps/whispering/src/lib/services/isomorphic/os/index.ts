import { createOsServiceDesktop } from './desktop';
import { createOsServiceWeb } from './web';

export type { OsService, OsError } from './types';

export const OsServiceLive = window.__TAURI_INTERNALS__
	? createOsServiceDesktop()
	: createOsServiceWeb();
