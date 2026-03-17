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
 * `KeyManager` structurally satisfies auth's `EncryptionAdapter` interface—
 * `Promise<T>` return types are assignable to `void`, and extra members
 * (`lock`) are ignored by structural typing. No adapter wrapper needed.
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
