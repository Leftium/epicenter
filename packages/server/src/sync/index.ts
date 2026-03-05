/**
 * Sync plugin public API.
 *
 * This is the entry point for `@epicenter/server/sync`.
 * CRITICAL: This file must NOT import from `@epicenter/workspace` — it's the dependency firewall.
 */

export {
	compactDoc,
	createMemorySyncStorage,
	decodeSyncRequest,
	encodeSyncRequest,
	type SyncStorage,
	stateVectorsEqual,
} from '@epicenter/sync-core';
export { createHttpSyncPlugin, type HttpSyncPluginConfig } from './http/plugin';
export { createWsSyncPlugin, type WsSyncPluginConfig } from './ws/plugin';
