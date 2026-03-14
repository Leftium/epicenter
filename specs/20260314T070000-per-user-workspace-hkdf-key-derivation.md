# Per-User-Workspace HKDF Key Derivation

**Date**: 2026-03-14
**Status**: Draft
**Replaces**: `specs/20260314T064000-per-workspace-envelope-encryption.md`
**Depends on**: `specs/20260314T063000-encryption-wrapper-hardening.md` (mode system, AAD, error containment)
**Builds on**: `specs/20260313T180100-client-side-encryption-wiring.md` (key delivery to apps)

## Overview

Replace the deployment-wide encryption key (`SHA-256(BETTER_AUTH_SECRET)`) with per-user-per-workspace keys derived via HKDF. Each user gets a unique key for each workspace they access, limiting blast radius to one user's data in one app per compromised key. No new database tables, no wrapped DEKs, no key storage—keys are deterministically derived from a server secret.

## Motivation

### Current State

```typescript
// apps/api/src/app.ts — every session gets the same key
async function deriveKeyFromSecret(secret: string): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return new Uint8Array(hash);
}

customSession(async ({ user, session }) => {
  const encryptionKey = await deriveKeyFromSecret(env.BETTER_AUTH_SECRET);
  return { user, session, encryptionKey: bytesToBase64(encryptionKey) };
}),
```

This creates three problems:

1. **Deployment-wide blast radius.** One compromised client can decrypt any captured ciphertext from any workspace for any user. The key is identical for every session.
2. **No tenant isolation.** A single XSS or session leak exposes every user's data, not just the affected user's.
3. **Auth-encryption coupling.** Rotating `BETTER_AUTH_SECRET` (for auth purposes) simultaneously changes the encryption key, requiring re-encryption of all data.

### Desired State

```typescript
// Server: per-user-workspace key, derived on demand
const key = await deriveWorkspaceKey(env.WORKSPACE_KEY_SECRET, workspaceId, userId);

// Client: workspace-scoped key fetch
const response = await fetch(`/workspaces/${workspaceId}/key`);
const { key } = await response.json();
workspaceKeyCache.set(workspaceId, base64ToBytes(key));

// Workspace: closes over its own key
createEncryptedKvLww(yarray, {
  key: workspaceKeyCache.getSync(workspaceId),
});
```

## Research Findings

### Why Per-User-Workspace (Not Per-Workspace)

| Derivation | Blast radius | Sharing | Complexity |
|---|---|---|---|
| Per-deployment (current) | All users, all apps | Trivial | Zero |
| Per-workspace (workspaceId) | All users of one app | Trivial | Low |
| **Per-user-workspace** (workspaceId + userId) | **One user, one app** | Server-mediated | Low |

In Epicenter's model, "workspace" = "app" (e.g., `epicenter.whispering`). Per-workspace keys would mean a single key compromise exposes all users' transcriptions—still a large blast radius. Per-user-workspace gives the tightest isolation with identical implementation complexity.

**Key finding**: Durable Objects are already per-user. The natural key derivation boundary matches the storage boundary.

### Why HKDF (Not Random DEKs / Envelope Encryption)

| Approach | Key storage | Key rotation | Sharing | Implementation |
|---|---|---|---|---|
| **HKDF derivation** | None (deterministic) | New secret → re-derive all | Phase 2 (shared rooms) | ~30 lines server code |
| Random DEK + server wrap | Postgres table | Re-wrap only, no re-encrypt | Insert wrapped copy | New table, endpoint, migration logic |

HKDF gives all the tenant isolation benefits of envelope encryption without the operational complexity. The main trade-off—rotation requires re-derivation rather than re-wrapping—is acceptable because:

- Key rotation is a rare admin operation
- No production encrypted data exists yet
- Re-wrapping still requires touching every row in the key table

### What Real Products Do

Notion, Linear, and Slack rely on cloud provider encryption at rest (AWS KMS default). None ship per-workspace envelope encryption as a default feature. Slack's Enterprise Key Management is a paid add-on on their highest tier. Per-user-workspace HKDF gives more granular isolation than any of these products provide.

### HKDF and Sharing: Architectural Constraint

Per-user keys are fundamentally incompatible with shared CRDTs. In a shared Y.Doc, Alice's encrypted write must be readable by Bob. With per-user keys, Bob cannot decrypt Alice's blob.

**This is a cryptographic constraint, not an implementation limitation.** No junction table or authz layer can make per-user HKDF work for shared encrypted state. Shared rooms require a shared key.

This is acceptable because:

1. All workspaces are currently private (per-user Durable Objects)
2. Sharing is not on the near-term roadmap
3. When sharing ships, shared rooms will use a different key derivation path (Phase 2)

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Key derivation | `HKDF(SHA-256(WORKSPACE_KEY_SECRET), "workspace:{wsId}:user:{userId}:v1")` | Per-user-per-workspace isolation. Deterministic, no storage needed. Version label enables future format changes. |
| Separate secret | `WORKSPACE_KEY_SECRET` env var (not `BETTER_AUTH_SECRET`) | Decouples auth rotation from encryption. Cheap hygiene—one extra env var. |
| Key delivery | `GET /workspaces/:id/key` endpoint | Fetch on workspace open, not on login. Client only gets keys for workspaces it actually opens. Session token authenticates. |
| Key in session | **Removed** | Session no longer carries encryption key. Keys are workspace-scoped, not session-scoped. |
| Sharing strategy | Deferred to Phase 2 | Per-user keys don't support shared CRDTs. When sharing ships, shared rooms get workspace-level keys. |
| Envelope encryption | Deferred to Phase 3 | Only needed for enterprise BYOK or user-held keys. HKDF is sufficient for trusted-server model. |
| Zero-knowledge sharing | Out of scope | Requires public-key infrastructure. Different product entirely. |

## Architecture

### Key Hierarchy

```
WORKSPACE_KEY_SECRET (env var, separate from BETTER_AUTH_SECRET)
       │
       │  SHA-256(secret) → root key material
       │
       │  HKDF-SHA256(root, info="workspace:{wsId}:user:{userId}:v1")
       ▼
┌──────────────────────────────────────────┐
│  Per-user-workspace key (32 bytes)       │
│  Deterministic — same inputs = same key  │
│  No storage needed                       │
└──────────────┬───────────────────────────┘
               │
               │  Returned via GET /workspaces/:id/key
               │  (authenticated, authorized)
               ▼
┌──────────────────────────────────────────┐
│  Client (in-memory)                      │
│                                          │
│  workspaceKeyCache.set(wsId, key)        │
│  key: cache.getSync(wsId)       │
│  createEncryptedKvLww(yarray, { key })│
└──────────────────────────────────────────┘
```

### Login → First Encrypted Write

```
1. User authenticates with Better Auth
   └── Session token issued (no encryption key in session)

2. App opens workspace 'epicenter.whispering'
   └── Client: GET /workspaces/epicenter.whispering/key
       (session cookie authenticates, server reads userId from session)

3. Server handles key request
   ├── Verify user has access to workspace
   ├── root = SHA-256(WORKSPACE_KEY_SECRET)
   ├── key = HKDF(root, info="workspace:epicenter.whispering:user:usr-123:v1")
   └── Return { key: base64(key) }

4. Client receives key
   ├── workspaceKeyCache.set('epicenter.whispering', base64ToBytes(key))
   └── wrapper.unlock(key)  ← from hardening spec

5. First encrypted write
   └── kv.set('tab-1', data) → encryptValue(json, key, aad) → inner CRDT
```

## Phased Approach

This spec implements Phase 1. Phases 2 and 3 are documented here for architectural context but are explicitly deferred.

### Phase 1: Per-User-Workspace HKDF (This Spec)

Everything is private. Every room gets a user-specific key.

**Server changes:**
- Add `WORKSPACE_KEY_SECRET` env var
- Replace `deriveKeyFromSecret(BETTER_AUTH_SECRET)` with HKDF derivation
- Add `GET /workspaces/:id/key` endpoint
- Remove `encryptionKey` from session response

**Client changes:**
- Create `WorkspaceKeyCache` (in-memory Map)
- Fetch key on workspace open, store in cache
- Pass `key` to `createEncryptedKvLww`

### Phase 2: Shared Room Keys (When Sharing Ships)

When collaborative workspaces exist, the key endpoint gains one branch:

```typescript
if (room.isShared) {
  // All authorized members derive the same key
  return hkdfDerive(root, `workspace:${wsId}:shared:v1`)
} else {
  // Per-user key
  return hkdfDerive(root, `workspace:${wsId}:user:${userId}:v1`)
}
```

Still deterministic. Still no storage. Authz gates who can request the key.

**Trade-off**: Shared room blast radius = all members of that workspace. This is inherent to shared encrypted state—all readers need the same decryption key.

### Phase 3: Envelope Encryption for Shared Rooms (If Enterprise Demand)

Replace shared room HKDF with actual random DEKs + wrapped copies, only for shared rooms. Private rooms stay on HKDF forever.

- Random 32-byte DEK per shared workspace
- `workspace_user_key` table in Postgres (one row per user-workspace pair)
- Server wraps DEK with KEK, stores wrapped copy per user
- Enables: cheap KEK rotation, per-user key revocation, future BYOK

**Only build this when**: enterprise customers require it, or user-held keys become a product requirement.

## Implementation Plan

### Phase 1: Server Key Derivation

- [ ] **1.1** Add `WORKSPACE_KEY_SECRET` env var to `wrangler.jsonc` and local dev config. Separate from `BETTER_AUTH_SECRET`.
- [ ] **1.2** Implement `deriveWorkspaceKey(secret, workspaceId, userId)` — uses Web Crypto HKDF-SHA256: import `SHA-256(secret)` as HKDF key material, derive 256 bits with `info="workspace:{wsId}:user:{userId}:v1"` and empty salt.
- [ ] **1.3** Add `GET /workspaces/:id/key` Hono route. Authenticates via session, reads userId from session, verifies workspace access, derives key, returns `{ key: base64(derivedKey) }`.
- [ ] **1.4** Remove `encryptionKey` from `customSession` plugin response. Session no longer carries any encryption key.
- [ ] **1.5** Remove `deriveKeyFromSecret` and its `bytesToBase64` helper from `app.ts` (replaced by HKDF derivation).

### Phase 2: Client Key Cache

- [ ] **2.1** Create `WorkspaceKeyCache` interface: `set(workspaceId, key)`, `getSync(workspaceId)`, `clear()`. In-memory implementation (Map). Scoped per-workspace, not per-user.
- [ ] **2.2** Create `fetchWorkspaceKey(workspaceId)` async helper that calls `GET /workspaces/:id/key`, decodes the base64 key, stores in cache, and calls `wrapper.unlock(key)`.

### Phase 3: Per-App Wiring

- [ ] **3.1** **epicenter** — On workspace open, call `fetchWorkspaceKey`. Pass `key: cache.getSync(wsId)` to `createWorkspace`.
- [ ] **3.2** **whispering** — Same pattern.
- [ ] **3.3** **tab-manager** — Same pattern. Verify Chrome extension can call the key endpoint.

### Phase 4: Verify

- [ ] **4.1** `bun test` in `packages/workspace` — all pass
- [ ] **4.2** `bun run typecheck` — clean
- [ ] **4.3** Manual: sign in → open workspace → verify per-user key fetched → new writes produce EncryptedBlob → sign out → workspace locked

### DO NOT build yet (deferred to future phases):

- `workspace_user_key` Postgres table (Phase 3)
- KEK derivation / wrap / unwrap helpers (Phase 3)
- Key rotation re-wrapping (Phase 3)
- Shared workspace key derivation (Phase 2)

## Edge Cases

### First workspace open

1. `GET /workspaces/epicenter.whispering/key` → server derives key from inputs
2. Server doesn't store anything—derivation is deterministic
3. Same request tomorrow produces the same key (same inputs)

### Secret rotation

1. Admin rotates `WORKSPACE_KEY_SECRET`
2. All derived keys change (HKDF outputs are different for different input key material)
3. Existing ciphertext becomes undecryptable with new keys
4. **Mitigation**: Re-encrypt all workspace data during rotation window. Since no production encrypted data exists yet, this is a future concern.
5. **Future mitigation**: Store key version in EncryptedBlob (v:2 could indicate new key epoch), support keyring of old/new derived keys during rotation.

### User loses access to workspace

1. Admin removes user from workspace
2. User's next `GET /workspaces/:id/key` returns 403
3. Client can't fetch key → workspace stays locked
4. User already had key in memory during session—can't revoke in-memory keys retroactively. This is inherent to any client-side encryption scheme (same limitation as Signal, iMessage, etc.).

### Offline with cached key

1. User opens workspace, key cached in memory
2. Network goes down
3. Reads/writes continue locally (CRDT)
4. Sync resumes when network returns—no key re-fetch needed (key is in memory)
5. Full page refresh without network → no key available → workspace locked until network returns (unless persistent KeyCache is implemented)

### Multiple workspaces open simultaneously

1. User opens `epicenter.whispering` and `epicenter.tab-manager`
2. Two separate `GET /workspaces/:id/key` calls → two different derived keys
3. `WorkspaceKeyCache` stores both: `cache.getSync('epicenter.whispering')` and `cache.getSync('epicenter.tab-manager')` return different keys
4. Each workspace's `key` option reads from the correct cache entry

## What This Replaces

This spec supersedes `specs/20260314T064000-per-workspace-envelope-encryption.md` (full envelope encryption with random DEKs and Postgres key storage).

| Aspect | Old spec (envelope) | This spec (HKDF) |
|---|---|---|
| DEK source | Random bytes, stored in Postgres | Deterministic HKDF, no storage |
| KEK | HKDF from WORKSPACE_KEY_SECRET | N/A (no wrapping layer) |
| Storage | `workspace_user_key` Postgres table | None |
| Key rotation | Re-wrap DEKs only | Re-derive all (or support keyring) |
| Sharing | Insert wrapped DEK copy | Phase 2: workspace-level derivation |
| Implementation | ~200 lines server + migration | ~30 lines server |
| Blast radius | 1 workspace (all users) | **1 user, 1 workspace** |

The HKDF approach has a **tighter blast radius** than envelope encryption while being simpler. Envelope encryption is deferred to Phase 3 for shared rooms only, if enterprise demand warrants it.

## Open Questions

1. **Should the HKDF salt be empty or derived?**
   - HKDF with empty salt is standard (RFC 5869 §3.1: "if not provided, [salt] is set to a string of HashLen zeros").
   - A non-empty salt adds no security when the input key material is already high-entropy (SHA-256 of a secret).
   - **Recommendation**: Empty salt. Simpler, standard-compliant, no benefit from salt in this context.

2. **Should we implement persistent `WorkspaceKeyCache` now?**
   - Without it: every page refresh requires a network roundtrip before decryption works.
   - With it: workspace decrypts instantly from cache, auth roundtrip happens in background.
   - **Recommendation**: Start with in-memory only. Add `sessionStorage` persistence as a fast follow if refresh latency is noticeable.

3. **Should the key endpoint be part of the sync WebSocket handshake or a separate HTTP call?**
   - WebSocket: fewer round-trips, key arrives with the sync connection.
   - HTTP: simpler, cacheable, no coupling between key delivery and sync protocol.
   - **Recommendation**: Separate HTTP endpoint. Keep concerns decoupled. The key fetch is a one-time cost per workspace open.

## Success Criteria

- [ ] Each user gets a unique key per workspace via `GET /workspaces/:id/key`
- [ ] Keys are derived via HKDF (not stored in any database)
- [ ] `WORKSPACE_KEY_SECRET` is separate from `BETTER_AUTH_SECRET`
- [ ] Session response no longer contains `encryptionKey`
- [ ] All existing tests pass, typecheck clean, apps build
- [ ] Blast radius = one user's data in one workspace per compromised key

## References

- `apps/api/src/app.ts` — current `deriveKeyFromSecret` and `customSession` (to be replaced)
- `packages/workspace/src/shared/crypto/index.ts` — encryption primitives (unchanged)
- `packages/workspace/src/shared/crypto/key-cache.ts` — `KeyCache` interface (WorkspaceKeyCache replaces this for the encryption use case)
- `specs/20260314T063000-encryption-wrapper-hardening.md` — prerequisite (mode system, AAD, error containment)
- `specs/20260313T180100-client-side-encryption-wiring.md` — original wiring plan (app inventory still useful reference)
- RFC 5869 — HKDF specification
- Web Crypto API — `crypto.subtle.deriveBits` with HKDF algorithm
