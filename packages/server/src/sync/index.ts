/**
 * Sync plugin public API.
 *
 * This is the entry point for `@epicenter/server/sync`.
 * CRITICAL: This file must NOT import from `@epicenter/workspace` — it's the dependency firewall.
 */

export type { VerifyToken } from './auth';
export { createSyncPlugin, type SyncPluginConfig } from './plugin';
