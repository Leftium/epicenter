/**
 * Sync plugin public API.
 *
 * This is the entry point for `@epicenter/server/sync`.
 * CRITICAL: This file must NOT import from `@epicenter/workspace` — it's the dependency firewall.
 */

export { createHttpSyncPlugin, type HttpSyncPluginConfig } from './http-sync-plugin';
export { createWsSyncPlugin, type WsSyncPluginConfig } from './ws-sync-plugin';
export {
	type SyncStorage,
	createMemorySyncStorage,
	decodeSyncRequest,
	encodeSyncRequest,
	stateVectorsEqual,
} from './storage';

/** @deprecated Use `createWsSyncPlugin` instead. */
export { createSyncPlugin, type SyncPluginConfig } from './plugin';
