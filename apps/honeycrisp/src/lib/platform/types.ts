import type { SyncAuthClient } from '@epicenter/auth';

/**
 * Contract for `#platform/auth`. Every impl (browser today, Tauri in Phase 2)
 * annotates its `auth` export with this type so the variants stay in lockstep.
 * This file must stay free of `@tauri-apps/*` imports.
 */
export type PlatformAuth = SyncAuthClient;
