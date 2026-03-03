import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const DownloadError = defineErrors({
	Service: ({ message }: { message: string }) => ({ message }),
});
export type DownloadError = InferErrors<typeof DownloadError>;

export type DownloadService = {
	downloadBlob: (args: {
		name: string;
		blob: Blob;
	}) => Promise<Result<void, DownloadError>>;
};
