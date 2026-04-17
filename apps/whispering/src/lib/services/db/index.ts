import { DownloadServiceLive } from '$lib/services/download';
import { createDbServiceDesktop } from './desktop';
import { createDbServiceWeb } from './web';

export type { DbService } from './types';
export { DbError } from './types';

export const DbServiceLive = window.__TAURI_INTERNALS__
	? createDbServiceDesktop({ DownloadService: DownloadServiceLive })
	: createDbServiceWeb({ DownloadService: DownloadServiceLive });
