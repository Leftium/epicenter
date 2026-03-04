/**
 * Sync plugin public API.
 *
 * This is the entry point for `@epicenter/server/sync`.
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
} from './http/storage';
export { createWsSyncPlugin, type WsSyncPluginConfig } from './ws/plugin';
