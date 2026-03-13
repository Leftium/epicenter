# Client-Side Encryption Wiring

**Date**: 2026-03-13
**Status**: Draft
**Builds on**: `specs/20260313T180000-encrypted-blob-format-simplification.md`, `specs/20260312T120000-y-keyvalue-lww-encrypted.md`, `specs/20260213T005300-encrypted-workspace-storage.md`
**Related**: PR #1507 (encryption infrastructure), `apps/api/src/app.ts` (server-side key delivery)

## Overview

Wire the encryption infrastructure from PR #1507 into every auth-backed app. The crypto primitives and encrypted KV wrapper exist but are dormant—every app calls `createWorkspace(definition)` without `getKey`, so nothing encrypts. This spec activates encryption by delivering the server-provided key to each app's workspace.

## Motivation

### Current State

The server already delivers an encryption key via Better Auth's `customSession` plugin:

```typescript
// apps/api/src/app.ts — server side (already implemented)
customSession(async ({ user, session }) => {
  const encryptionKey = await deriveKeyFromSecret(env.BETTER_AUTH_SECRET);
  return { user, session, encryptionKey: bytesToBase64(encryptionKey) };
}),
```

But no client consumes it. Every app creates its workspace without `getKey`:

```typescript
// Current: encryption dormant
const workspace = createWorkspace(definition)
  .withExtension('persistence', ...)
  .withExtension('sync', ...);
```

### Desired State

```typescript
// After: encryption active when signed in
const workspace = createWorkspace(definition, {
  getKey: () => encryptionKeyStore.get(),
})
  .withExtension('persistence', ...)
  .withExtension('sync', ...);
```

The key flows from the server session to an in-memory store, and `getKey` reads from that store synchronously. Before auth completes, `getKey()` returns `undefined` (passthrough). After sign-in, encryption activates automatically.

## Architecture

```
Better Auth Server (customSession plugin)
       │
       │  session response: { user, session, encryptionKey: "base64..." }
       ▼
┌─────────────────────────────────────────────────┐
│  Auth Client (per app)                          │
│  + customSessionClient() plugin                 │
│  session.encryptionKey is typed and accessible   │
└────────────────────┬────────────────────────────┘
                     │
                     │  $session store subscription
                     ▼
┌─────────────────────────────────────────────────┐
│  Encryption Key Store (in-memory module)        │
│                                                 │
│  setKey(base64) → decode → store Uint8Array     │
│  getKey() → Uint8Array | undefined              │
│  clearKey() → undefined                         │
└────────────────────┬────────────────────────────┘
                     │
                     │  getKey getter (synchronous)
                     ▼
┌─────────────────────────────────────────────────┐
│  createWorkspace(definition, { getKey })         │
│                                                 │
│  getKey() === undefined → passthrough (before auth)
│  getKey() === Uint8Array → encrypts (after auth) │
└─────────────────────────────────────────────────┘
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Key storage | In-memory module (not persistent cache) | Server delivers key on every session fetch. No need for persistent KeyCache until "offline restart with encrypted data" becomes a real requirement. |
| Key format in memory | `Uint8Array` (decoded from base64 once) | Avoids repeated base64 decode on every `getKey()` call. |
| Auth client plugin | `customSessionClient()` from `better-auth/client/plugins` | Required to type `session.encryptionKey` on the client. Server already uses `customSession`. |
| Loading gate | App-level, not library-level | Auth-backed apps show a loading state until key is available. Library stays platform-agnostic. |
| No-auth apps | Unchanged | `fs-explorer` and `tab-manager-markdown` don't have auth, don't need encryption. |
| One commit per app | Yes | Each app is independently deployable and testable. |

## App Inventory

| App | Platform | Has Auth | Encryption? | Key Source |
|-----|----------|----------|-------------|-----------|
| epicenter | Tauri desktop (Svelte) | Yes (OAuth/PKCE) | ✅ Wire | Session via `customSessionClient` |
| whispering | Tauri desktop (Svelte) | Yes | ✅ Wire | Session via `customSessionClient` |
| tab-manager | Chrome extension (WXT/Svelte) | Yes | ✅ Wire | Session via `customSessionClient` |
| fs-explorer | Browser (Svelte) | No | ❌ Skip | N/A |
| tab-manager-markdown | Node.js CLI | No | ❌ Skip | N/A |

## Implementation Plan

### Phase 1: Shared Utilities

- [ ] **1.1** Create a shared `createEncryptionKeyStore()` factory in `packages/workspace` (or a shared lib) that returns `{ set(base64Key), get(): Uint8Array | undefined, clear() }`. Uses `base64ToBytes` from the crypto module. Pure in-memory, no persistence.

### Phase 2: Per-App Wiring (one commit each)

For each auth-backed app:

- [ ] **2.1** **epicenter** — Add `customSessionClient()` to auth client config. Subscribe to `$session` to populate key store on sign-in and clear on sign-out. Pass `{ getKey }` to `createWorkspace`. Add loading gate in app shell.
- [ ] **2.2** **whispering** — Same pattern. Auth client → key store → workspace `getKey`.
- [ ] **2.3** **tab-manager** — Same pattern. Note: Chrome extension auth flow may have different session access patterns (popup vs background). Verify `$session` subscription works in the extension context.

### Phase 3: Verify

- [ ] **3.1** Run `bun test` in `packages/workspace`—all tests pass (passthrough still works)
- [ ] **3.2** Run `bun run typecheck` across the monorepo
- [ ] **3.3** Verify each app builds: `bun run build` in each app directory
- [ ] **3.4** Manual verification: sign in → check that new KV writes produce `EncryptedBlob` in Y.Doc. Sign out → check that `getKey()` returns `undefined`.

## Edge Cases

### Workspace Created Before Auth Completes

This is the common case—workspaces are created at module scope as side-effect-free exports. The `getKey` getter returns `undefined` until the session loads, so early reads/writes use passthrough. Once the session arrives and the key store is populated, subsequent writes encrypt. This is by design—the getter pattern exists specifically for this scenario.

### Session Refresh / Token Rotation

When Better Auth refreshes the session, `$session` emits a new value. The key store should update (though the key itself won't change unless `BETTER_AUTH_SECRET` rotates). The subscription handles this transparently.

### Sign Out

On sign-out, `$session` emits `null`. The key store clears. Subsequent writes fall through to passthrough. This is acceptable—after sign-out, the workspace should be inaccessible anyway (auth gate).

### Mixed Plaintext and Encrypted Data

When encryption first activates, existing data is plaintext. The encrypted wrapper's `maybeDecrypt` function checks `isEncryptedBlob()` on every read. Plaintext values pass through. New writes encrypt. Over time, as entries are edited, they migrate from plaintext to encrypted. No explicit migration step needed for the initial rollout.

## Open Questions

1. **Should the key store live in `packages/workspace` or per-app?**
   - Options: (a) shared factory in workspace package, (b) each app implements its own
   - **Recommendation**: (a) shared factory—the logic is identical across apps, and it can be imported alongside `createWorkspace`.

2. **Loading gate UX—what does the user see before auth completes?**
   - The workspace is functional in passthrough mode, so the app could render immediately. But writes would be plaintext until the key arrives.
   - **Recommendation**: Show a brief loading skeleton until `$session` resolves. Most apps already have auth gates.

3. **Tab-manager extension context—does `$session` work in service workers?**
   - The extension's auth client may behave differently in the WXT background script vs popup.
   - **Recommendation**: Investigate during implementation. If `$session` doesn't work in the service worker, use `chrome.storage.session` as an intermediary.

## Success Criteria

- [ ] `customSessionClient()` added to all 3 auth-backed apps
- [ ] `session.encryptionKey` is typed and accessible in each app
- [ ] Each app passes `{ getKey }` to `createWorkspace`
- [ ] New KV/table writes produce `EncryptedBlob` when signed in
- [ ] Reads decrypt transparently (existing plaintext + new ciphertext coexist)
- [ ] Sign-out clears the key; subsequent writes are passthrough
- [ ] All tests pass, typecheck clean, each app builds

## References

- `packages/workspace/src/shared/crypto/index.ts`—`base64ToBytes`, `EncryptedBlob`
- `packages/workspace/src/shared/crypto/key-cache.ts`—`KeyCache` interface (not used yet, but defines the future extensibility point)
- `packages/workspace/src/workspace/create-workspace.ts`—`options.getKey` parameter
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts`—`createEncryptedKvLww`, `getKey` getter pattern
- `apps/api/src/app.ts`—server-side `customSession` plugin delivering `encryptionKey`
- `apps/epicenter/src/lib/yjs/workspace.ts`—Epicenter workspace creation
- `apps/whispering/src/lib/workspace.ts`—Whispering workspace creation
- `apps/tab-manager/src/lib/workspace.ts`—Tab Manager workspace creation
- Better Auth docs: `customSessionClient()` from `better-auth/client/plugins`
