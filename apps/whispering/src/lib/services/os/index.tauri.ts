import * as os from '@tauri-apps/plugin-os';
import type { OsService } from './types';

export type { OsError, OsService } from './types';

export const OsServiceLive: OsService = {
	type: () => os.type(),
};
