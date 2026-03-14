# Encryption Wrapper Hardening

**Date**: 2026-03-14
**Status**: Draft
**Builds on**: `specs/20260313T202000-encrypted-blob-pack-nonce.md`, `specs/20260312T120000-y-keyvalue-lww-encrypted.md`
**Blocks**: `specs/20260314T070000-per-user-workspace-hkdf-key-derivation.md` (key derivation depends on hardening being in place)

## Overview

Harden `createEncryptedKvLww` with three explicit encryption modes, error containment, a key transition hook, and AAD context binding. These are prerequisite fixes before real encryption keys flow to real clients.

## Motivation

### Current State

```typescript
// y-keyvalue-lww-encrypted.ts — current behavior
const getKey = options?.getKey ?? (() => undefined);

// set() — no key = plaintext passthrough
const keyBytes = getKey();
if (!keyBytes) return inner.set(key, val);
inner.set(key, encryptValue(JSON.stringify(val), keyBytes));

// maybeDecrypt — no error handling
const maybeDecrypt = (value: EncryptedBlob | T): T => {
  const key = getKey();
  if (!key || !isEncryptedBlob(value)) return value as T;
  return JSON.parse(decryptValue(value, key)) as T; // throws on bad blob
};
```

This creates four problems:

1. **Sign-out writes plaintext over ciphertext.** When a user signs out, `getKey()` returns `undefined`. New writes go plaintext. A plaintext write with a newer LWW timestamp permanently replaces previously encrypted data—security downgrade via timestamp.
2. **One bad blob crashes all observation.** `decryptValue` or `JSON.parse` throwing inside the `inner.observe()` handler kills the entire observation chain. Every consumer of that table stops receiving updates.
3. **Map hydration doesn't rebuild on key arrival.** The wrapper builds its decrypted map once at creation. If the workspace loads before auth completes, encrypted entries stay as raw `{ v: 1, ct: '...' }` blobs in the map until each entry is individually touched by a new observer event.
4. **No ciphertext context binding.** Ciphertext from `table:posts/post-1` can be copied to `table:users/user-1` and decrypts successfully. AES-GCM supports Additional Authenticated Data (AAD) at zero extra cost.

### Desired State

```typescript
// Three explicit modes
type EncryptionMode = 'plaintext' | 'locked' | 'unlocked';

// set() in locked mode rejects writes
if (mode === 'locked') throw new Error('Workspace is locked — sign in to write');

// observer catches decrypt failures
const decrypted = trySync(() => maybeDecrypt(entry.val));
if (decrypted.error) { quarantine(key, entry); continue; }

// key transition rebuilds the map
wrapper.onKeyChange(newKey);  // re-decrypts all entries, transitions mode
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Mode state machine | `plaintext` → `unlocked` ↔ `locked` | `plaintext` is the initial state for workspaces that have never seen a key. Once a key arrives, mode becomes `unlocked`. Key cleared → `locked`. `locked` rejects writes to prevent plaintext overwriting ciphertext. |
| Locked mode behavior | `set()` throws, `get()` returns cached plaintext | Reads should still work (map was populated while unlocked). Writes must fail to prevent security downgrade. |
| Error containment | `trySync` wrapper around `maybeDecrypt`, skip failed entries | A quarantine approach (log + skip) is better than a throw that kills all observation. Quarantined entries can be retried when the correct key arrives. |
| AAD format | `encode(workspaceId + ':' + tableName + ':' + entryKey)` | Binds ciphertext to its exact position. Prevents cross-table replay. Uses string concatenation with `:` separator (no ambiguity since IDs are UUIDs). |
| AAD as optional parameter | `encryptValue(plaintext, key, aad?)` | Backward compatible—existing code without AAD still works. The wrapper passes AAD; direct callers in tests can omit it. |
| `onKeyChange` scope | Rebuilds `wrapper.map` from `inner.map` | Re-iterates all entries, decrypts with the new key, replaces the entire map. Fires synthetic change events so observers see the transition. |
| Mode persistence | Not persisted—derived from key presence | Mode is runtime state. On fresh page load, workspace starts in `plaintext` if no key cache, or `unlocked` if key cache provides a key. No need to store mode. |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  createEncryptedKvLww                                       │
│                                                             │
│  mode: 'plaintext' | 'locked' | 'unlocked'                 │
│                                                             │
│  set(key, val)                                              │
│    ├── mode === 'locked'  → throw Error                     │
│    ├── mode === 'plaintext' → inner.set(key, val)           │
│    └── mode === 'unlocked' → encrypt + inner.set            │
│                                                             │
│  inner.observe(changes)                                     │
│    ├── trySync(maybeDecrypt(entry.val))                     │
│    │   ├── ok → map.set(key, decrypted)                     │
│    │   └── err → quarantine.set(key, entry), log warning    │
│    └── forward decrypted changes to handlers                │
│                                                             │
│  onKeyChange(key: Uint8Array | undefined)                   │
│    ├── key present  → mode = 'unlocked', rebuild map        │
│    ├── key cleared  → mode = 'locked' (if was unlocked)     │
│    └── key cleared  → mode = 'plaintext' (if was plaintext) │
│                                                             │
│  encryptValue(plaintext, key, aad?)                         │
│  decryptValue(blob, key, aad?)                              │
└─────────────────────────────────────────────────────────────┘
```

### Mode Transitions

```
                    ┌─────────────┐
        (creation,  │  PLAINTEXT  │  (no key ever seen)
         no key)    │  rw plain   │
                    └──────┬──────┘
                           │ onKeyChange(key)
                           ▼
                    ┌─────────────┐
                    │  UNLOCKED   │  (key active)
                    │  rw encrypt │◄─── onKeyChange(newKey)
                    └──────┬──────┘
                           │ onKeyChange(undefined)
                           ▼
                    ┌─────────────┐
                    │   LOCKED    │  (key was active, now cleared)
                    │  r-only     │
                    └──────┬──────┘
                           │ onKeyChange(key)
                           ▼
                    ┌─────────────┐
                    │  UNLOCKED   │  (re-sign-in)
                    └─────────────┘
```

Note: `plaintext` → `locked` never happens. `locked` means "was unlocked before." A workspace that never had a key stays `plaintext` through sign-out because there's no ciphertext to protect.

## Implementation Plan

### Phase 1: Encryption Primitives — AAD Support

- [ ] **1.1** Update `encryptValue(plaintext, key, aad?)` — pass `aad` to `gcm(key, nonce, aad)`. When `aad` is undefined, behavior is identical to today.
- [ ] **1.2** Update `decryptValue(blob, key, aad?)` — pass `aad` to `gcm(key, nonce, aad)`. Mismatched AAD causes GCM auth tag failure (throws).
- [ ] **1.3** Update tests: add round-trip test with AAD, add test that mismatched AAD throws.

### Phase 2: Wrapper Hardening

- [ ] **2.1** Add `mode` state (`plaintext` | `locked` | `unlocked`) to `createEncryptedKvLww`. Initialize based on whether `getKey()` returns a key at creation time.
- [ ] **2.2** Gate `set()` on mode — throw in `locked`, encrypt in `unlocked`, passthrough in `plaintext`.
- [ ] **2.3** Wrap `maybeDecrypt` calls in observer with error containment. On failure, store the raw entry in a `quarantine` map and log a warning. Skip the entry in `wrapper.map`.
- [ ] **2.4** Add `onKeyChange(key: Uint8Array | undefined)` method. Re-iterates `inner.map`, re-decrypts all entries, rebuilds `wrapper.map`, retries quarantined entries, transitions mode, fires synthetic change events.
- [ ] **2.5** Wire AAD into the wrapper: compute `encode(workspaceId + ':' + tableName + ':' + entryKey)` for each encrypt/decrypt call. Accept `workspaceId` and `tableName` as new options to `createEncryptedKvLww`.

### Phase 3: Tests

- [ ] **3.1** Mode transitions: plaintext → unlocked → locked → unlocked round-trip
- [ ] **3.2** Locked mode: verify `set()` throws, `get()` still returns cached values
- [ ] **3.3** Error containment: inject a corrupted blob, verify observation continues for other entries
- [ ] **3.4** Key transition: create wrapper without key, add entries as plaintext, call `onKeyChange(key)`, verify new writes encrypt and map is rebuilt
- [ ] **3.5** AAD: verify cross-table ciphertext replay fails (decrypt with wrong AAD throws)

### Phase 4: Update Docs

- [ ] **4.1** Update module JSDoc in `y-keyvalue-lww-encrypted.ts` — document mode system, replace "Current behavior" note in key lifecycle state machine
- [ ] **4.2** Update `crypto/index.ts` JSDoc — document AAD parameter
- [ ] **4.3** Update wiring spec — mark Phase 0 items as implemented

## Edge Cases

### Workspace loads before auth, user has cached key

1. `KeyCache.get()` returns a key from last session
2. `onKeyChange(cachedKey)` called immediately → mode = `unlocked`
3. Workspace decrypts from cache while auth roundtrip completes in background
4. Session arrives → same key (or rotated key) → `onKeyChange` again → no-op or re-decrypt

### Key rotation (same user, new key)

1. Server rotates KEK, user gets new DEK on next session
2. `onKeyChange(newKey)` called
3. Old ciphertext was encrypted with old key → `maybeDecrypt` with new key fails → entries go to quarantine
4. **This is a real problem.** Key rotation requires either: (a) re-encrypting data server-side before rotation, or (b) supporting a keyring of recent keys.
5. **Recommendation**: Defer keyring support to the envelope encryption spec. For now, key rotation = re-encrypt data first.

### Multiple tables in one workspace

Each table gets its own AAD context (`workspaceId:tableName:entryKey`). A value encrypted in `tabs` cannot be replayed into `settings` even if the key is the same.

## Open Questions

1. **Should `locked` mode throw on `set()` or silently no-op?**
   - Throw: consumer knows immediately something is wrong. But unhandled throws in UI code can crash components.
   - No-op: silent data loss—user thinks they saved but nothing persisted.
   - **Recommendation**: Throw. The UI should have an auth gate that prevents reaching the write path when locked.

2. **Should quarantined entries be exposed via the API?**
   - Options: (a) internal-only, just skip them, (b) expose `wrapper.quarantine` as a read-only map
   - **Recommendation**: (b) expose it. Table helpers could show a "N entries failed to decrypt" warning.

3. **Should `onKeyChange` fire synthetic `add` events for all entries?**
   - On a full rebuild, every entry in `wrapper.map` changes from possibly-wrong to decrypted.
   - Options: (a) fire `update` for changed entries only, (b) fire `add` for everything, (c) fire a single bulk event
   - **Recommendation**: (a) fire `update` only for entries whose decrypted value actually changed.

## Success Criteria

- [ ] `set()` throws in `locked` mode, encrypts in `unlocked`, passes through in `plaintext`
- [ ] One corrupted blob does not prevent other entries from decrypting
- [ ] `onKeyChange` rebuilds the decrypted map and transitions mode correctly
- [ ] AAD mismatch causes decrypt failure (GCM auth tag verification)
- [ ] All existing tests pass (backward compatible—no AAD = same behavior)
- [ ] New tests cover mode transitions, error containment, key transition, and AAD

## References

- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts` — primary file to modify
- `packages/workspace/src/shared/crypto/index.ts` — AAD parameter addition
- `packages/workspace/src/shared/crypto/crypto.test.ts` — AAD tests
- `specs/20260313T180100-client-side-encryption-wiring.md` — Phase 0 items reference this spec
- `@noble/ciphers` docs — `gcm(key, nonce, aad)` API for AAD support
