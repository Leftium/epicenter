import { toast } from '@epicenter/ui/sonner';
import type { ModelDownloadResult } from '$lib/state/local-model-downloads.svelte';

/**
 * Toast the outcome of a catalog download and return the folder entry name to
 * select, or `null` when selection should stay put (the call was a no-op or
 * failed). The recommended-model hero and the catalog row present the same
 * download the same way, so both route their result through here.
 */
export function announceModelDownload(result: ModelDownloadResult): string | null {
	if (!result) return null;
	if (result.error) {
		toast.error('Failed to download model', {
			description: result.error.message,
		});
		return null;
	}

	toast.success(
		result.data.outcome === 'already-installed'
			? 'Model already downloaded and activated'
			: 'Model downloaded and activated successfully',
	);
	return result.data.entryName;
}
