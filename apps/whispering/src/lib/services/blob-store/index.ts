import { isTauri } from '@tauri-apps/api/core';
import { createBlobStoreDesktop } from './desktop';
import { createBlobStoreWeb } from './web';

export type { BlobStore } from './types';
export { BlobError } from './types';

export const AudioBlobStoreLive = isTauri()
	? createBlobStoreDesktop()
	: createBlobStoreWeb();
