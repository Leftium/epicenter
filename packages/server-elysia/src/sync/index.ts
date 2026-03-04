/**
 * Sync plugin public API.
 *
 * This is the entry point for `@epicenter/server-elysia/sync`.
 * CRITICAL: This file must NOT import from `@epicenter/workspace` — it's the dependency firewall.
 */

export { createHttpSyncPlugin, type HttpSyncPluginConfig } from './http/plugin';
export {
	type SyncStorage,
	compactDoc,
	createMemorySyncStorage,
	decodeSyncRequest,
	encodeSyncRequest,
	stateVectorsEqual,
} from '@epicenter/sync-core';
export { createWsSyncPlugin, type WsSyncPluginConfig } from './ws/plugin';
