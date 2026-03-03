import type { OsType } from '@tauri-apps/plugin-os';
import { defineErrors, type InferErrors } from 'wellcrafted/error';

export const OsError = defineErrors({
	Service: () => ({ message: 'OS service operation failed' }),
});
export type OsError = InferErrors<typeof OsError>;

export type OsService = {
	type: () => OsType;
};
