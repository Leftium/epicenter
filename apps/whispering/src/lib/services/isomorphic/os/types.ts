import type { OsType } from '@tauri-apps/plugin-os';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

export const OsError = defineErrors({
	DetectionFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to detect OS type: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type OsError = InferErrors<typeof OsError>;

export type OsService = {
	type: () => OsType;
};
