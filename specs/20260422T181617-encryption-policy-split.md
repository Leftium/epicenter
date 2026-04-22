# Split Encryption Mechanism from Policy

**Date**: 2026-04-22
**Status**: Draft
**Author**: AI-assisted
**Branch**: braden-w/document-primitive (continuing)

## Overview

Separate the encryption *mechanism* (encrypt/decrypt, keyring with versioned fallback, coordinator bookkeeping) from the *policy* (when does re-encryption run, can you write without keys). The library ships mechanisms; apps compose the policy they want.

Three policies cover every real Epicenter app:

1. **Plaintext forever** — no encryption at all.
2. **Encrypt-after-login with eventual re-encryption** (the default) — user writes freely before sign-in; post-sign-in writes are encrypted; pre-sign-in rows get re-encrypted after login and the ciphertext propagates via normal CRDT sync.
3. **Zero-knowledge strict** — user must unlock (password or auth) before the first write.

No hidden state transitions. Every transition the app cares about is a method call the app made or a flag the app passed. The library keeps the current security guarantees available, just named and opted-into.

## Motivation

### Current state

`attachEncryption` today bundles three things into a single hidden state transition:

1. **Active key state** — `encryption: EncryptionState | undefined` on each store. A store without keys writes plaintext; one with keys writes ciphertext.
2. **Retroactive re-encryption** — `activateEncryption` walks every entry, finds plaintext, re-encrypts in place, under `REENCRYPT_ORIGIN` so the observer filters it out.
3. **Synthetic `add` events** — when re-encryption makes previously-undecryptable ciphertext readable, it fakes downstream `add` events to catch observers up.

All three ship together, implicitly, triggered by the first `applyKeys(...)` call. There's no way to opt a single app out of (2) + (3) without forking the library. There's no way to opt in to a strict "cannot write without keys" mode at all.

This bundling costs ~85 lines across `y-keyvalue-lww-encrypted.ts` and `attach-encryption.ts`, but more importantly it *decides the policy for you*: "when keys arrive, everything that existed before becomes ciphertext-at-rest in one go." For apps that wanted that, great. For apps that want a stricter mode (no writes before unlock), not available. For apps that want no encryption at all, the library is silent (which is fine — you just don't call `attachEncryption`).

### The insight

The **read path is policy-free**. `y-keyvalue-lww-encrypted.ts:237` already handles any mix of plaintext + versioned ciphertext via one `isEncryptedBlob` branch and a keyring-with-fallback decrypt. Performance is a single byte check plus one XChaCha20-Poly1305 decrypt on hit — microseconds. There's no policy choice to make on the read side.

The **write path and the re-encryption walk** are where policy lives. Surface them.

### The stated invariant

Epicenter apps that use encryption need this invariant:

> **The live state on every device eventually contains only ciphertext.**

Transient plaintext on the server (while a user is mid-login, while sync races re-encryption) is acceptable — it self-heals via CRDT LWW propagation once any authenticated device runs `reencryptAll`. What matters is the eventual convergence, not the absence of any plaintext op in the CRDT history. (See "CRDT history retention" below for the nuance.)

That invariant is what Policy 3 delivers, and why Policy 3 is the default.

## The three policies

### Policy 1 — Plaintext forever

**User story**: "This app does not use encryption. All data is plaintext at rest and over the wire."

**Who this fits**: tab manager, any app where data has no privacy requirement.

```ts
const app = defineDocument((id) => {
  const ydoc = new Y.Doc({ guid: id });
  const tables = attachTables(ydoc, myTables);
  const idb = attachIndexedDb(ydoc);
  const sync = attachSync(ydoc, { url, getToken });
  return { ydoc, tables, idb, sync, /* ... */ };
});
```

No `attachEncryption` call. Zero encryption code involved. **Already supported today. No library change needed.**

### Policy 3 — Encrypt after login, with eventual re-encryption (DEFAULT)

**User story**: "Use the app freely before signing in. Once you sign in, your post-login writes are end-to-end encrypted, and everything you wrote beforehand gets re-encrypted and propagates to all your devices as ciphertext. Plaintext may briefly exist on the server during the re-encryption window, but the live state converges to ciphertext everywhere."

**Who this fits**: Fuji, Whispering, Opensidian, Honeycrisp, Zhongwen — any app that offers offline-first usage before auth and wants encryption to "just work" once the user signs in.

```ts
const app = defineDocument((id) => {
  const ydoc = new Y.Doc({ guid: id });
  const encryption = attachEncryption(ydoc);
  const tables = encryption.attachTables(ydoc, myTables);
  const kv = encryption.attachKv(ydoc, myKv);
  const idb = attachIndexedDb(ydoc);
  const sync = attachSync(ydoc, {
    getToken: async () => auth.token,
    waitFor: idb.whenLoaded,
  });
  return { ydoc, tables, kv, encryption, idb, sync, /* ... */ };
});

// On login:
workspace.encryption.applyKeys(session.encryptionKeys);
// applyKeys also re-encrypts existing plaintext rows, synchronously.
// Ciphertext writes propagate via normal CRDT sync.
workspace.sync.reconnect();
```

**Guarantee to the user**: "The live state on every device eventually contains only ciphertext. Pre-login data becomes ciphertext on disk after you sign in, and that ciphertext version wins on every device via normal sync."

**How eventual re-encryption works (why this is safe under CRDT sync):**

```
t0:  Device A writes {id: X, val: Y_plain, ts: 1000} offline. IDB only.
t1:  Device A gets a token and signs in.
t2:  Device A's sync connects; may upload plaintext before t3 finishes.
     Server briefly has plaintext row X.
t3:  applyKeys runs. reencryptAll walks plaintext rows.
     For row X: set(X, Y) re-runs through the encrypted store → writes
     {id: X, val: Y_enc, ts: 2000} (monotonic timestamp post-sync).
t4:  Sync uploads ciphertext. Server's LWW layer picks ts=2000 (ciphertext)
     winner over ts=1000 (plaintext); deletes the plaintext entry from the
     live yarray.
t5:  Device B (another device on the same account) downloads. Its live
     state has only the ciphertext row.
```

All devices converge. No app-level coordination needed across devices — the CRDT does the work.

**This is the library default.** `applyKeys(keys)` implicitly calls `reencryptAll()` to deliver this behavior. Apps get eventual encryption by default, without writing extra lines.

### Policy 4 — Zero-knowledge strict

**User story**: "You enter a password (or sign in). Until you do, you cannot write. No data ever exists in this workspace in plaintext, anywhere."

**Who this fits**: password managers; zero-knowledge, local-first, password-unlocked apps; any app where the product promise is "we never see your data, not even during setup."

```ts
const app = defineDocument((id) => {
  const ydoc = new Y.Doc({ guid: id });
  const encryption = attachEncryption(ydoc, { strict: true });
  const tables = encryption.attachTables(ydoc, myTables);
  const idb = attachIndexedDb(ydoc);
  return { ydoc, tables, encryption, idb, /* ... */ };
});

// Before the user enters their password:
workspace.tables.secrets.set({ id: '1', value: 'x', _v: 1 });
// → throws EncryptionNotReadyError

// Unlock flow (local password, no server involved):
const userKey = deriveFromPassword(password, workspaceSalt);
workspace.encryption.applyKeys([{ version: 1, userKeyBase64: toBase64(userKey) }]);

// Now writes work.
workspace.tables.secrets.set({ id: '1', value: 'x', _v: 1 });
```

**Guarantee to the user**: "No data exists in this workspace in plaintext. Ever. Not on disk, not in operations, not anywhere. If you haven't entered your password, you haven't written anything."

## Proposed API changes

All changes are **additive**. Existing code that calls `attachEncryption(ydoc)` and `applyKeys(keys)` keeps working and keeps its current behavior. No migration required for any existing Epicenter app.

### 1. `attachEncryption(ydoc, opts?)` — new optional `strict` flag

```ts
function attachEncryption(
  ydoc: Y.Doc,
  opts?: { strict?: boolean },
): EncryptionAttachment;
```

- `strict: false` (default) — writes before `applyKeys` pass through as plaintext. Current behavior; enables Policy 3.
- `strict: true` — writes before `applyKeys` throw `EncryptionNotReadyError`. Enables Policy 4.

Implementation: the flag is threaded to backing `EncryptedYKeyValueLww` construction. One branch in `set` / `bulkSet`, one error type.

### 2. `encryption.reencryptAll()` — new public method

```ts
type EncryptionAttachment = {
  // ... existing methods ...
  reencryptAll(): void;
};
```

- Walks every registered store's entries, re-encrypts plaintext under `REENCRYPT_ORIGIN`, emits synthetic `add` events for newly-readable ciphertext.
- Synchronous (matches `applyKeys`).
- Throws if called before keys are active.
- Idempotent: second call with nothing left to re-encrypt is a no-op.

Currently this logic lives inside `activateEncryption` on each store and runs implicitly on first `applyKeys`. It continues to run there (the default `applyKeys` calls it). The new public method is for:

- **Key rotation**: after `applyKeys(newKeys)`, apps may want to explicitly re-encrypt old-version ciphertext with the new key. Call `encryption.reencryptAll()`.
- **User-triggered migrations**: "re-encrypt my data" as a user action in settings.
- **Explicit app-level control**: apps that want `applyKeys` to be a pure state-swap (see opt-out below).

### 3. `applyKeys(keys, opts?)` — new optional `reencryptExisting` flag

```ts
type EncryptionAttachment = {
  applyKeys(keys: EncryptionKeys, opts?: { reencryptExisting?: boolean }): void;
  // ...
};
```

- `reencryptExisting: true` (default) — runs `reencryptAll()` immediately after activating keys. Policy 3 behavior, current library default.
- `reencryptExisting: false` — pure state-swap; does not walk existing plaintext. Apps choosing this accept that pre-login plaintext stays plaintext at rest (and on the server once synced). Rarely the right choice; available for apps that explicitly want it.

### 4. `activateEncryption(keyring)` on each store — stays as-is

Each `EncryptedYKeyValueLww`'s `activateEncryption(keyring)` keeps doing both state-swap AND re-encryption walk, because that's what the coordinator's `applyKeys` (with default `reencryptExisting: true`) needs. When `reencryptExisting: false` is requested, the coordinator uses a lower-level state-swap path that skips the walk.

**Alternative considered**: split per-store `activateEncryption` into `activateEncryption` (state-swap only) + `reencryptPlaintext` (the walk). Rejected for now — the split adds a method without adding user-visible power, since no app reaches into individual stores. Revisit if we expose per-store handles.

## What's in, what's out

**Library-level (mechanisms — load-bearing, all stay):**

- `isEncryptedBlob`-tolerant reads with versioned keyring fallback.
- `createEncryptedYkvLww` construction (plus optional `initialKeyring`, plus new `strict` flag).
- Per-store `activateEncryption(keyring)`.
- `REENCRYPT_ORIGIN` observer filter + synthetic `add` events — still used inside re-encryption walks.
- Per-entry AAD binding, HKDF workspace-key derivation, `encryptionKeysFingerprint` dedup.
- Coordinator's `register`, `cachedKeyring`, `lastKeysFingerprint` for late-registrant bookkeeping.

**App-level (policy — now explicit instead of implicit):**

- `applyKeys` default behavior unchanged, but documented honestly: "applies keys AND re-encrypts existing plaintext."
- Opt-out flag `{ reencryptExisting: false }` for the rare app that wants Policy-2-shaped behavior.
- Strict flag `{ strict: true }` on `attachEncryption` for Policy 4.
- Public `reencryptAll()` for key rotation, user-triggered migrations, and the rare app that wants to separate the state-swap from the walk.

**Deleted**: nothing. The proposal is purely additive.

## Security guarantees per policy

| Policy | At-rest encryption | Over-the-wire encryption | Pre-login data after login | First-write latency |
|---|---|---|---|---|
| 1 — Plaintext | None | None | N/A — no login concept | Instant |
| 3 — Encrypt-after-login w/ re-encrypt (default) | Eventually all ciphertext | Briefly plaintext during re-encrypt window, then ciphertext | Re-encrypted on device, propagates to server via LWW | Instant |
| 4 — Zero-knowledge strict | Always | Always | N/A — nothing exists pre-unlock | Blocks on unlock |

**Threat model assumptions (shared across policies):**

- Server is honest-but-curious / subpoena-able / breach-able.
- Client device is trusted up to the moment key material is in memory.
- User's auth session is the root of trust for Policies 1 (if it syncs at all) and 3; user's password is the root for Policy 4.

### CRDT history retention — important nuance

Yjs docs with `gc: false` (our standard setup for synced docs) retain the full operation history. When `reencryptAll` rewrites a plaintext row, the LWW layer marks the old plaintext entry as a CRDT loser and deletes it from the live yarray — but the plaintext operation itself persists in the doc's update log. A full state export (`Y.encodeStateAsUpdate(ydoc)`) still contains the plaintext op.

**What this means:** Policy 3's guarantee is about *live state*, not *history*. On a device that runs `reencryptAll`, any subsequent `get(key)` returns only ciphertext or decrypted ciphertext. But a subpoena of the server's raw doc bytes could surface plaintext ops that existed transiently.

If an app needs plaintext-free history, the answer is Policy 4 — nothing was ever written plaintext, so the history has no plaintext ops to retain.

For Epicenter's stated invariant (*live state eventually ciphertext; transient plaintext on server acceptable*), Policy 3 is sufficient. Apps selling stronger guarantees need Policy 4.

## Migration impact

**Zero action needed for any existing Epicenter app.** The default `applyKeys(keys)` behavior is unchanged. Existing apps that call it keep their Policy 3 behavior.

**Apps that choose to adopt the new flags:**

- Any app that wants Policy 4: add `{ strict: true }` to `attachEncryption(ydoc)`. Add error handling for `EncryptionNotReadyError` in write paths, block writes in UI until unlock completes.
- Any app that wants Policy 2 (rare — accept pre-login plaintext staying plaintext): pass `{ reencryptExisting: false }` to `applyKeys`.

**No version bump.** Packages in this repo are pre-release (`workspace@0.2.0`, everything else `@0.1.0`), unaligned, and not yet published to a public registry. Ship under the existing version. Version alignment is a separate cleanup ticket.

## Implementation waves

### Wave 1 — additions

- Add `strict` flag to `attachEncryption(ydoc, opts?)`. Thread it to `createEncryptedYkvLww` construction. Branch in `set` / `bulkSet` / `activateEncryption` (reject activation when strict + keys already active? revisit).
- Add `EncryptionNotReadyError` type, export from `@epicenter/workspace`.
- Add public `reencryptAll()` method on `EncryptionAttachment`. Fans out to each registered store's existing re-encrypt walk.
- Add optional `{ reencryptExisting }` param to `applyKeys`. Default `true` preserves current behavior.

After Wave 1: all three policies are expressible; existing apps unchanged.

### Wave 2 — documentation

- Update `packages/workspace/README.md` "Plaintext vs encrypted" section to describe the three policies, not a binary. Include the "eventual re-encryption via CRDT sync" walkthrough.
- Add an encryption-policies guide (`docs/guides/encryption-policies.md` or inline in workspace README) with:
  - A policy selector ("how do I pick?")
  - Code samples for each policy
  - The CRDT-history-retention nuance
- Update `.agents/skills/workspace-api/references/primitive-api.md` to cover `strict`, `reencryptAll`, `reencryptExisting`.
- Add JSDoc to `reencryptAll` explaining legit use cases (key rotation, user-triggered migration).

### Wave 3 — optional hardening (stretch)

- Runtime warning if `attachSync` connects while `strict: true` and keys aren't active. (Catches wiring bugs.)
- Tests for the CRDT convergence path described in Policy 3 — two-device scenario, device A writes plaintext pre-login, device B logs in first, re-encrypt propagates to A.
- Benchmark `reencryptAll` at various row counts to set user expectations in docs ("100 rows: instant. 10k rows: ~0.5s on a modern laptop.").

## Open questions

1. **Key rotation UX.** If a user changes their password, the active keyring rotates (old keys stay for decryption, new key becomes `currentVersion`). Does `applyKeys(newKeys)` automatically re-encrypt old-version ciphertext with the new key? Currently it does NOT — only plaintext gets walked. Apps that want full-keyring-rotation call `reencryptAll` explicitly. Document this; surface as a best practice in the key-rotation section of the guide.

2. **`reencryptAll` granularity.** Does it accept an optional filter for apps that want to re-encrypt one table or one key range at a time? Probably no for v1 — YAGNI. Add later if needed.

3. **Error type placement.** `EncryptionNotReadyError` lives where — `@epicenter/workspace` public surface, or `@epicenter/workspace/crypto`? Pick in Wave 1.

4. **Sync coupling in Policy 3.** Should `attachSync`'s `waitFor` optionally take `encryption.whenKeysApplied` so sync can be gated on encryption-ready for apps that want Policy 3 but DON'T want the transient server-side plaintext window? This approximates "Policy 3 with strict ordering." Decide in Wave 2 based on how many apps ask for it.

## Non-goals

- **Two-workspace anonymous migration model.** Considered and rejected. Policy 3 with the default `reencryptAll` achieves eventual-encryption across devices via normal CRDT sync without forcing apps to manage two `defineDocument` factories. If a specific app later needs the strictest invariant (no plaintext ever in CRDT history), use Policy 4 instead of a two-workspace split.
- **Touch-on-write lazy re-encryption.** Mentioned in earlier discussion. Rejected — doubles every write, leaks information through re-encrypt ordering, and doesn't self-heal inactive rows.
- **Per-row policy choice.** Encryption is a per-store decision (via `encryption.attachTable` vs plain `attachTable`). Keep.
- **Deprecating or breaking the current `applyKeys(keys)` signature.** No deprecation. Adding optional params only.

## Rationale summary

The library today is opinionated about *when* re-encryption happens (on first key application) and *whether* writes are allowed without keys (always). The first opinion is correct for most apps; the second is too permissive for zero-knowledge apps. By exposing both as explicit flags, the library supports every real policy without forcing any existing app to change a single line.

The three policies that matter — plaintext forever, encrypt-after-login-with-eventual-re-encryption, zero-knowledge strict — cover every Epicenter app. Each is a short, honest composition of primitives. The implicit machinery stays where it belongs (inside the library) but is no longer the only way to use the library.
