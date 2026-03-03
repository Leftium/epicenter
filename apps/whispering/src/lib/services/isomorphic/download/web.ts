import { extractErrorMessage } from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import type { DownloadService } from '.';
import { DownloadError } from './types';

export function createDownloadServiceWeb(): DownloadService {
	return {
		downloadBlob: ({ name, blob }) =>
			tryAsync({
				try: async () => {
					const file = new File([blob], name, { type: blob.type });
					const url = URL.createObjectURL(file);
					const a = document.createElement('a');
					a.href = url;
					a.download = name;
					document.body.appendChild(a);
					a.click();
					document.body.removeChild(a);
					URL.revokeObjectURL(url);
				},
				catch: (error) =>
					DownloadError.Service({
						message: `There was an error saving the recording in your browser. Please try again. ${extractErrorMessage(error)}`,
					}),
			}),
	};
}
