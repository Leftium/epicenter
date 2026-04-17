import { DownloadServiceLive } from '$lib/services/download';
import { createBlobStoreDesktop } from './desktop';
import { createBlobStoreWeb } from './web';

export type { BlobStore } from './types';
export { BlobError } from './types';

export const BlobStoreLive = window.__TAURI_INTERNALS__
	? createBlobStoreDesktop({ DownloadService: DownloadServiceLive })
	: createBlobStoreWeb({ DownloadService: DownloadServiceLive });
