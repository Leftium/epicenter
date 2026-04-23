---
name: wire-auth-to-sync
status: Draft
---

# Shared `wireAuthToSync` helper for app `client.svelte.ts`

## Motivation

Four apps (fuji, honeycrisp, opensidian, tab-manager) hand-roll the same session-transition wiring:

```ts
auth.onSessionChange((next, previous) => {
  if (next === null) {
    sync.goOffline();
    sync.setToken(null);
    if (previous !== null) void idb.clearLocal();
    return;
  }
  encryption.applyKeys(next.encryptionKeys);
  sync.setToken(next.token);
  sync.reconnect();
});
```

Zhongwen uses a subset (no sync). Tab-manager adds `void registerDevice()` to the logged-in branch. Opensidian, honeycrisp, and fuji are byte-identical.

This block is a **protocol**, not an app-specific policy:

- Logout -> take sync offline, clear token, wipe local data only on a real logout (not on cold-boot-anonymous).
- Login/rotation -> apply keys, push token, reconnect.

Four copies means four places to fix when the protocol grows (e.g., awareness needs to know the user changed; or a new invariant about ordering).

The `applySession` bridge that previously owned this logic was deleted in the auth-core-package spec because it coupled auth and workspace. The right shape is a **small helper that takes the pieces and wires them** — not a method on workspace.

## Non-goals

- Moving back to a workspace-owned `applySession`. The pieces stay explicit.
- Changing the transition semantics. The helper captures what's already there.
- Hiding `auth.onSessionChange` behind something fancier. Subscription stays imperative.

## Design

### Location

`packages/workspace/src/attach/wire-auth-to-sync.ts`. Exported from the main `@epicenter/workspace` barrel. Rationale: the helper touches `sync`, `encryption`, and `idb` — all workspace primitives — so this package owns the protocol.

### API

```ts
export function wireAuthToSync({
  auth,
  sync,
  encryption,
  idb,
  onSessionApplied,
}: {
  auth: Pick<AuthCore, 'onSessionChange'>;
  sync: Pick<SyncAttachment, 'goOffline' | 'setToken' | 'reconnect'>;
  encryption: Pick<EncryptionAttachment, 'applyKeys'>;
  idb: Pick<IndexedDbAttachment, 'clearLocal'>;
  /** Called after a login or rotation applies, once encryption + sync are armed. */
  onSessionApplied?: (session: AuthSession) => void;
}): () => void;
```

Returns the unsubscribe from `auth.onSessionChange`.

### Behavior

Exactly matches the current copies:

- `next === null && previous !== null`: real logout -> `sync.goOffline()`, `sync.setToken(null)`, `void idb.clearLocal()`.
- `next === null && previous === null`: cold-boot anonymous -> no-op beyond `sync.setToken(null)`.
- `next !== null`: login or rotation -> `encryption.applyKeys(next.encryptionKeys)`, `sync.setToken(next.token)`, `sync.reconnect()`, then `onSessionApplied?.(next)`.

`onSessionApplied` is the hook that tab-manager uses for `registerDevice()`. It fires every time a session is applied (login + every rotation), matching the existing behavior — `registerDevice` is already written to be idempotent.

### Migration

Each app's `client.svelte.ts` replaces its `auth.onSessionChange` block with:

```ts
wireAuthToSync({ auth, sync, encryption, idb });
```

Tab-manager:

```ts
wireAuthToSync({
  auth, sync, encryption, idb,
  onSessionApplied: () => { void registerDevice(); },
});
```

Zhongwen doesn't have `sync`, so it keeps its hand-rolled subscription (or we ship a separate `wireAuthToEncryption` for the sync-less case — flag but defer until we see if another app wants it).

## Open questions

- Do we want `onSessionApplied` to fire on logout too (with `null`)? Current callers don't need it. Start without it; add if a caller needs it.
- Should `onLogout` run *before* or *after* `sync.goOffline()`? Current order is "sync first, then clearLocal" — keep that.

## Rollout

Single commit per consumer, plus one for the helper. Typecheck each app after migration to confirm no behavioral drift.

## Out of scope / follow-ups

- Collapsing the `createPersistedState` + `fromPersistedState` + `createAuth` boilerplate into a `createAuthSessionStore(key)` helper in `@epicenter/auth-svelte`. Orthogonal. Separate spec.
