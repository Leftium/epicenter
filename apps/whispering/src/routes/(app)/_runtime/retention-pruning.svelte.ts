/**
 * Owns automatic retention pruning for settled recordings.
 */

import { services } from '$lib/services';
import { recordings } from '$lib/state/recordings.svelte';
import { settings } from '$lib/state/settings.svelte';

export const retentionPruningRuntime = {
	attach() {
		$effect(() => {
			const strategy = settings.get('retention.strategy');
			if (strategy === 'keep-forever') return;

			const maxCount =
				strategy === 'keep-none' ? 0 : settings.get('retention.maxCount');

			const settledIds = recordings.sorted
				.filter((recording) => recording.transcription !== null)
				.map((recording) => recording.id);
			if (settledIds.length <= maxCount) return;

			const idsToDelete = settledIds.slice(maxCount);
			services.blobs.audio.delete(idsToDelete);
			recordings.bulkDelete(idsToDelete);
		});
	},
};
