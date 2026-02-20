/**
 * Sync plugin public API.
 *
 * This is the entry point for `@epicenter/server/sync`.
 * CRITICAL: This file must NOT import from `@epicenter/hq` — it's the dependency firewall.
 */

export type { AuthConfig } from './auth';
export { createSyncPlugin, type SyncPluginConfig } from './plugin';
export { createSyncServer, type SyncServerConfig } from './server';
