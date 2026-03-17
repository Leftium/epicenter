/**
 * Module-scope key manager for the tab manager extension.
 *
 * ```
 * auth.svelte.ts                this file             @epicenter/workspace
 * ┌──────────────┐    ┌─────────────────────┐    ┌───────────────────┐
 * │ createAuth    │───▶│ keyManager          │───▶│ createKeyManager   │
 * │ State(km)     │    │ (module-scope       │    │ (HKDF, dedup,      │
 * └──────────────┘    │  construction)      │    │  race protection)  │
 *                     └─────────────────────┘    └───────────────────┘
 * ```
 *
 * Auth receives the key manager directly via constructor injection.
 * `KeyManager`'s `Promise<T>` return types are assignable to `void`,
 * so auth can fire-and-forget async methods (wipe, restoreKeyFromCache)
 * without awaiting.
 *
 * @example
 * ```typescript
 * // In auth.svelte.ts
 * import { keyManager } from './key-manager.svelte';
 *
 * export const authState = createAuthState(keyManager);
 * ```
 */

import { createKeyManager } from '@epicenter/workspace/shared/crypto';
import { workspaceClient } from '$lib/workspace';
import { keyCache } from './key-cache';

export const keyManager = createKeyManager(workspaceClient, { keyCache });
