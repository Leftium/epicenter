# KeyCache Implementation for Chrome Extension

**Date**: 2026-03-15
**Status**: Draft

## Overview

Implement a `KeyCache` backend for the Chrome extension using `chrome.storage.session`, then wire it into the encryption flow so the workspace can decrypt immediately on page refresh without waiting for a server roundtrip.

## Motivation

### Current State

On every page refresh or sidebar open, the encryption flow is:

```
App mounts → checkSession() → HTTP GET /auth/get-session → encryptionKey arrives → unlock()
```

Until `getSession()` completes (~50-200ms), the workspace is in `'plaintext'` mode. Encrypted IndexedDB data is unreadable. If the user is offline, `getSession()` fails and the workspace stays plaintext indefinitely—encrypted data is inaccessible until connectivity returns.

### Problems

1. **Offline users can't read their own data.** Encrypted entries in IndexedDB require the key, which only comes from the server. No network = no key = no decryption.
2. **Visible flash on refresh.** The UI renders with empty/loading state while waiting for the key. Tables appear empty, then populate once unlock fires.
3. **Unnecessary server load.** Every sidebar open, popup, and page refresh hits `/auth/get-session` just to re-derive the same key.

### Desired State

```
App mounts → KeyCache.get(userId) → key found → unlock() immediately
                                  → background: getSession() refreshes key silently
```

The workspace decrypts from cache on launch. The server roundtrip still happens but doesn't block the UI. Offline users read their data from cache.

## Research Findings

### The KeyCache Interface Already Exists

`packages/workspace/src/shared/crypto/key-cache.ts` defines the interface:

```typescript
type KeyCache = {
    set(userId: string, key: Uint8Array): Promise<void>;
    get(userId: string): Promise<Uint8Array | undefined>;
    clear(): Promise<void>;
};
```

The docs describe three platform implementations:

| Platform | Backend | Lifecycle |
|---|---|---|
| Tauri desktop | `tauri-plugin-stronghold` | Encrypted vault, memory zeroization |
| Browser | `sessionStorage` | Survives refresh, clears on tab close |
| Chrome extension | `chrome.storage.session` | Survives popup/sidebar close, clears on browser quit |

### chrome.storage.session

- Available in Manifest V3 extensions
- Data persists across popup/sidebar opens within a browser session
- Cleared when the browser closes (not on extension reload)
- Not encrypted at rest by default, but Chrome encrypts the storage partition
- 10MB quota (more than enough for a 32-byte key per user)
- Async API: `chrome.storage.session.get()` / `.set()` / `.remove()`

### Where the Key Enters the System Today

Two paths set `encryptionKey` in `auth.svelte.ts`:

1. `refreshEncryptionKey()` — called after signIn/signUp/signInWithGoogle. Gets key from `getSession()`.
2. `checkSession()` — called on app startup. Gets key from `getSession()`.

Both paths call the `getSession()` wrapper which returns typed `CustomSessionFields`. The `encryptionKey` is a base64 string. The encryption wiring then decodes it, derives a per-workspace key via HKDF, and calls `unlock()`.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Storage backend | `chrome.storage.session` | Persists across sidebar opens, auto-clears on browser quit. `sessionStorage` is per-document and wouldn't survive popup close. |
| Cache granularity | Per-user base64 string | Cache the raw base64 `encryptionKey` from the session, not the derived per-workspace key. The workspace key derivation (HKDF) is fast (~1ms) and caching the user key means it works across workspace ID changes. |
| Cache location | New file in `apps/tab-manager/src/lib/state/` | This is app-specific glue, not a workspace package concern. The KeyCache interface lives in the workspace package; the implementation lives in the app. |
| When to write | After every successful `getSession()` that returns a key | Ensures the cache has the latest key version after key rotation. |
| When to read | On app startup, before `checkSession()` | If cache hit, set `encryptionKey` immediately so the wiring unlocks. Then `checkSession()` refreshes it in the background. |
| When to clear | On `authState.signOut()` | User signed out = key should not persist. |
| KeyCache as required? | Optional | Apps without encryption (or that don't care about offline) skip it. |

## Architecture

```
App startup
  │
  ├─ keyCache.get(userId) ────────── cache hit? ─── yes ──→ encryptionKey = cached
  │                                       │                        │
  │                                       no                       ▼
  │                                       │                 wiring: unlock()
  │                                       ▼                 (instant, no network)
  │                                  encryptionKey = undefined
  │
  ├─ checkSession() ──→ getSession() ──→ encryptionKey = fresh key
  │                                       │
  │                                       ├─ keyCache.set(userId, key)  ← update cache
  │                                       ▼
  │                                  wiring: unlock() (or re-lock if key changed)
  │
  Sign-out
  │
  └─ keyCache.clear() ──→ encryptionKey = undefined ──→ wiring: lock()
```

## Implementation Plan

### Phase 1: Create the chrome.storage.session KeyCache

- [ ] **1.1** Create `apps/tab-manager/src/lib/state/key-cache.ts` implementing `KeyCache` with `chrome.storage.session`
- [ ] **1.2** Storage key format: `ek:{userId}` (matches the pattern in the KeyCache docs)
- [ ] **1.3** `clear()` should only remove `ek:*` keys, not wipe all session storage

### Phase 2: Wire cache writes

- [ ] **2.1** In the `getSession()` wrapper or `refreshEncryptionKey()`, after setting `encryptionKey`, also write to the cache: `keyCache.set(userId, base64ToBytes(key))`
- [ ] **2.2** In `authState.signOut()`, call `keyCache.clear()`
- [ ] **2.3** Need `userId` — check if `authUser.current?.id` is available at cache-write time

### Phase 3: Wire cache reads (startup fast path)

- [ ] **3.1** On app startup (before or alongside `checkSession()`), attempt `keyCache.get(userId)`
- [ ] **3.2** If cache hit, set `encryptionKey` immediately so the wiring unlocks
- [ ] **3.3** `checkSession()` still runs — if the server returns a different key (rotation), the wiring re-locks and re-unlocks with the new key
- [ ] **3.4** If cache hit but `checkSession()` returns 4xx (session expired), clear cache and lock

### Phase 4: Verify

- [ ] **4.1** Test: refresh sidebar with cached key — workspace decrypts instantly
- [ ] **4.2** Test: go offline, refresh — workspace still decrypts from cache
- [ ] **4.3** Test: sign out — cache cleared, next open requires sign-in
- [ ] **4.4** Test: key rotation — server returns new key, cache updated, workspace re-unlocks

## Edge Cases

### User signs in on a different account

1. User A signs in, key cached as `ek:userA`
2. User A signs out, `keyCache.clear()` removes `ek:userA`
3. User B signs in, key cached as `ek:userB`
4. No stale key issue — `clear()` runs on sign-out

### Key rotation (server changes ENCRYPTION_SECRETS)

1. App starts, loads cached key (old version)
2. `checkSession()` returns new key
3. `encryptionKey` updates, wiring re-locks then re-unlocks with new key
4. Cache updated with new key
5. Old encrypted entries: server would need to re-encrypt (out of scope)

### Browser closes mid-session

1. `chrome.storage.session` is automatically cleared by Chrome
2. Next browser launch: no cache, falls back to `checkSession()`
3. Clean state — no stale keys

### userId not available at cache-read time

1. On cold start, `authUser.current` might be undefined until `chrome.storage` loads
2. Need `authUser.whenReady` before attempting cache read
3. If no cached user, skip cache read — `checkSession()` handles everything

## Open Questions

1. **Should the cache store the base64 string or the raw bytes?**
   - `chrome.storage.session` stores JSON, so base64 string is natural (no Uint8Array serialization needed)
   - **Recommendation**: Store base64 string, decode on read. Simpler.

2. **Should the cache write happen inside `getSession()` wrapper or in the encryption wiring?**
   - Wiring has `workspaceClient.id` for per-workspace caching if we ever need it
   - `getSession()` wrapper is closer to the data source
   - **Recommendation**: Write in auth state (closer to the key), read in encryption wiring (closer to unlock). Defer to implementer.

3. **Should this be a Svelte-reactive store or a plain async utility?**
   - The encryption wiring already watches `authState.encryptionKey` reactively
   - The cache is just a side-channel for the same data
   - **Recommendation**: Plain async utility. No reactivity needed — it's a cache, not a state source.

## Success Criteria

- [ ] Sidebar refresh with existing session decrypts data without visible loading flash
- [ ] Offline page refresh still shows encrypted data (decrypted from cache)
- [ ] Sign-out clears the cache
- [ ] `checkSession()` updates the cache on every successful call
- [ ] No new circular dependencies

## References

- `packages/workspace/src/shared/crypto/key-cache.ts` — The interface to implement
- `apps/tab-manager/src/lib/state/auth.svelte.ts` — Where encryption key is set
- `apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts` — Where unlock/lock is called
- `apps/tab-manager/src/lib/workspace.ts` — Workspace singleton creation
