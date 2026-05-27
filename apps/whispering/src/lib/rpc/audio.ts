import type { Accessor } from '@tanstack/svelte-query';
import { defineKeys } from 'wellcrafted/query';
import { defineQuery } from '$lib/rpc/client';
import { services } from '$lib/services';

export const audioKeys = defineKeys({
	playbackUrl: (id: string) => ['audio', 'playbackUrl', id] as const,
});

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
