import { createMemorySyncStorage } from '@epicenter/sync-core';

/**
 * Ephemeral in-memory sync storage.
 *
 * The standalone hub is an ephemeral relay by design — the sidecar
 * (server-local) owns persistence via `.yjs` workspace files.
 * Clients resync their full state on reconnect via SyncStep1/SyncStep2.
 */
export function createStorage() {
	return createMemorySyncStorage();
}
