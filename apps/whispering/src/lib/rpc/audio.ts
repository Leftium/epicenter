import type { Accessor } from '@tanstack/svelte-query';
import { defineQuery } from '$lib/rpc/client';
import { audioKeys } from '$lib/rpc/keys';
import { services } from '$lib/services';

export const audio = {
	/**
	 * Get audio playback URL for a recording by ID.
	 * Audio blobs are too large for Yjs CRDTs, so they're still served
	 * from Dexie (web) / filesystem (desktop) via BlobStore.
	 */
	getPlaybackUrl: (id: Accessor<string>) =>
		defineQuery({
			queryKey: audioKeys.playbackUrl(id()),
			queryFn: () => services.blobs.audio.ensurePlaybackUrl(id()),
		}),
};
