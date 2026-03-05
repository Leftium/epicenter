/**
 * Sync plugin public API.
 *
 * This is the entry point for `@epicenter/server/sync`.
 * CRITICAL: This file must NOT import from `@epicenter/workspace` — it's the dependency firewall.
 */

export {
	createHttpSyncPlugin,
	type HttpSyncPluginConfig,
} from './http-sync-plugin';
/** @deprecated Use `createWsSyncPlugin` instead. */
export { createSyncPlugin, type SyncPluginConfig } from './plugin';
export {
	compactDoc,
	createMemorySyncStorage,
	decodeSyncRequest,
	encodeSyncRequest,
	type SyncStorage,
	stateVectorsEqual,
} from './storage';
export { createWsSyncPlugin, type WsSyncPluginConfig } from './ws-sync-plugin';
