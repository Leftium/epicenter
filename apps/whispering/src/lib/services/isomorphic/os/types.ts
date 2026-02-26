import type { OsType } from '@tauri-apps/plugin-os';
import { createTaggedError } from 'wellcrafted/error';

export const { OsServiceError, OsServiceErr } =
	createTaggedError('OsServiceError').withMessage(
		() => 'OS service operation failed',
	);

export type OsService = {
	type: () => OsType;
};
