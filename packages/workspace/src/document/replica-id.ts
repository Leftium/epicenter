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
 * are passed to `openCollaboration` as the `replicaId` config field and
 * echoed by the server onto a presence row inside the workspace Y.Doc. The
 * server stamps the authenticated `subject` on the same row; the two are
 * joined by the presence surface.
 */

import { generateGuid } from '../shared/id.js';

/** Storage primitive that mirrors the synchronous Web Storage shape. */
export type SimpleStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

/** Storage primitive with the async shape (chrome.storage, IndexedDB wrappers). */
export type AsyncStorage = {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<void>;
};

// Persisted under the legacy "installation.id" key. Do not rename: every
// existing user has this key in storage today; renaming invalidates their
// replica id and shows them up as a new device.
const KEY = 'epicenter.installation.id';

/** Read or lazily generate the replica id from a synchronous storage. */
export function createReplicaId({
	storage,
}: {
	storage: SimpleStorage;
}): string {
	const existing = storage.getItem(KEY);
	if (existing) return existing;
	const fresh = generateGuid();
	storage.setItem(KEY, fresh);
	return fresh;
}

/** Read or lazily generate the replica id from an async storage. */
export async function createReplicaIdAsync({
	storage,
}: {
	storage: AsyncStorage;
}): Promise<string> {
	const existing = await storage.getItem(KEY);
	if (existing) return existing;
	const fresh = generateGuid();
	await storage.setItem(KEY, fresh);
	return fresh;
}
