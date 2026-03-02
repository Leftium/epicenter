/**
 * Sync plugin public API.
 *
 * This is the entry point for `@epicenter/server/sync`.
 * CRITICAL: This file must NOT import from `@epicenter/workspace` — it's the dependency firewall.
 */

export type { AuthConfig } from './auth';
export { openAuth, tokenAuth, verifyAuth } from './auth';
export { createSyncPlugin, type SyncPluginConfig } from './plugin';
