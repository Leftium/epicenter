import type { Accessor } from '@tanstack/svelte-query';
import { defineQuery } from '$lib/rpc/client';
import { services } from '$lib/services';

export const audio = {
	/**
	 * Get audio playback URL for a recording by ID.
	 * Audio blobs are too large for Yjs CRDTs, so they're still served
	 * from Dexie (web) / filesystem (desktop) via BlobStore.
	 */
	getPlaybackUrl: (id: Accessor<string>) =>
		defineQuery({
			queryKey: ['audio', 'playbackUrl', id()],
			queryFn: () => services.blobs.audio.ensurePlaybackUrl(id()),
		}),
};
