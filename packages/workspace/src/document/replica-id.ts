/**
 * Replica id helper.
 *
 * A replica id is a stable string that identifies one installation of an
 * Epicenter app. Browser tabs in the same app share localStorage and therefore
 * share a replica id; separate browsers, machines, or device classes get
 * distinct replica ids. The id is generated on first call and persisted in the
 * supplied storage; subsequent calls return the persisted value.
 *
 * Replica ids are claimed by the client and only the client knows them. They
 * live inside the Yjs awareness payload as part of the `Replica` descriptor.
 * The server stamps the authenticated `subject` separately on the wire
 * envelope; the two are joined by the peers surface.
 */

import {
	type AsyncStorage,
	type SimpleStorage,
} from '../shared/device-id.js';
import { generateGuid } from '../shared/id.js';

export type { AsyncStorage, SimpleStorage };

const KEY = 'epicenter.installation.id';

/** Read or lazily generate the replica id from a synchronous storage. */
export function createReplicaId<T extends string = string>({
	storage,
}: {
	storage: SimpleStorage;
}): T {
	const existing = storage.getItem(KEY);
	if (existing) return existing as T;
	const fresh = generateGuid();
	storage.setItem(KEY, fresh);
	return fresh as unknown as T;
}

/** Read or lazily generate the replica id from an async storage. */
export async function createReplicaIdAsync<T extends string = string>({
	storage,
}: {
	storage: AsyncStorage;
}): Promise<T> {
	const existing = await storage.getItem(KEY);
	if (existing) return existing as T;
	const fresh = generateGuid();
	await storage.setItem(KEY, fresh);
	return fresh as unknown as T;
}
