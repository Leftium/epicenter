# Encrypted API Key Vault

**Date**: 2026-02-13
**Status**: Draft

## Overview

A zero-knowledge storage system for API keys (OpenAI, Anthropic, etc.) that enables secure sharing across Epicenter apps and devices. The server and sync relay only ever handle ciphertext; decryption happens exclusively on the client using a key derived from the user's password.

## How It Works (Plain English)

When you sign up, your browser generates a random Master Key. This is the key that actually encrypts your API keys. We never store it raw — instead, we derive a wrapping key from your password (using PBKDF2, which is intentionally slow to resist brute-force), use that to encrypt the Master Key, and store the encrypted result in Postgres. The server holds a locked box it can't open.

When you log in on a new device, the server sends down the locked box. Your browser re-derives the wrapping key from your password, unlocks the Master Key, and now it can decrypt any API keys that sync over via Y-sweet. The password never leaves your browser for this purpose, the Master Key never touches the server in plaintext, and Y-sweet only ever sees encrypted blobs.

Password changes are cheap: unwrap the Master Key with the old password, re-wrap with the new one. No need to re-encrypt every API key.

## Architecture

### Encryption Layers

The system uses a three-layer encryption hierarchy to balance security with performance (e.g., making password changes cheap).

```
USER PASSWORD
      │
      ▼ (PBKDF2: 600k iterations, SHA-256, Salt)
┌──────────────────────────┐
│  Key Encryption Key (KEK)│
└─────────────┬────────────┘
              │
              ▼ (AES-GCM Wrap)
┌──────────────────────────┐      ┌──────────────────────────┐
│    Wrapped Master Key    │ ────▶│    Stored in Postgres    │
└─────────────┬────────────┘      │   (via Better Auth)      │
              │                   └──────────────────────────┘
              ▼ (AES-GCM Unwrap)
┌──────────────────────────┐
│        Master Key        │
└─────────────┬────────────┘
              │
              ▼ (AES-GCM Encrypt/Decrypt)
┌──────────────────────────┐      ┌──────────────────────────┐
│    Encrypted API Key     │ ────▶│    Stored in Yjs KV      │
│   (Ciphertext + IV)      │      │    (Synced via Y-sweet)  │
└──────────────────────────┘      └──────────────────────────┘
```

### Cross-Device Sync Flow

When a user adds a second device, the Master Key is securely transferred via the authoritative database (Postgres) while the data itself syncs via the CRDT relay (Y-sweet).

```
DEVICE A (Origin)                 SERVER / DATABASE                DEVICE B (New)
─────────────────                 ─────────────────                ──────────────

1. Generate Master Key
2. Wrap with KEK(Password)
3. Store Wrapped Key ───────────▶ [ Postgres ]
4. Encrypt API Key
5. Store in KV LWW ─────────────▶ [ Y-sweet  ]

                                  [ Postgres ] ───────────────▶ 6. Fetch Wrapped Key
                                                                7. Unwrap with KEK(Password)
                                  [ Y-sweet  ] ───────────────▶ 8. Sync Encrypted KV
                                                                9. Decrypt API Key
```

## KV LWW Storage Format

Each API key is stored as a separate entry in the workspace's `Y.Array('kv')`:

```
kv.set('apiKey:openai', { ct: 'base64...', iv: 'base64...' })
kv.set('apiKey:anthropic', { ct: 'base64...', iv: 'base64...' })
```

This maps to `YKeyValueLww` entries: `{ key: 'apiKey:openai', val: { ct, iv }, ts: 1706200000000 }`.

If two devices update the same key concurrently, the one with the higher timestamp wins. Different keys (openai vs anthropic) never conflict with each other.

Y-sweet sees the key names (`apiKey:openai`) but not the values (encrypted). This is acceptable because the user either self-hosts the Y-sweet server or trusts the Epicenter Cloud relay.

## Better Auth: Wrapped Master Key Storage

The wrapped Master Key and its derivation parameters live on the user record:

| Field              | Type            | Purpose                                            |
| ------------------ | --------------- | -------------------------------------------------- |
| `wrappedMasterKey` | string (base64) | Master Key encrypted with the password-derived KEK |
| `masterKeySalt`    | string (base64) | 16-byte salt for PBKDF2 derivation                 |
| `masterKeyIv`      | string (base64) | 12-byte IV used for the AES-GCM wrap               |
| `keyVersion`       | number          | Encryption parameter version (for future upgrades) |

These are added via Better Auth's `additionalFields` on the user table. The server stores them but cannot decrypt the Master Key without the user's password.

## Design Decisions

| Decision            | Choice                           | Rationale                                                                                                                 |
| ------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Storage granularity | Individual keys in KV LWW        | Per-key LWW conflict resolution. Updating OpenAI doesn't conflict with Anthropic.                                         |
| Master key location | Postgres (Better Auth)           | Authoritative single source. No CRDT conflicts. Available immediately at login before Y-sweet syncs.                      |
| Binary encoding     | Base64 strings                   | KV LWW stores `{ key, val, ts }` objects. Base64 is safer for nested JSON structures than raw Uint8Array.                 |
| Key derivation      | PBKDF2, 600k iterations, SHA-256 | Only password-based KDF natively supported by Web Crypto API. 600k is the OWASP 2024+ recommendation.                     |
| Encryption          | AES-GCM-256                      | Authenticated encryption (confidentiality + integrity) via Web Crypto. 12-byte IV, 128-bit auth tag.                      |
| No subdocuments     | Use existing `Y.Array('kv')`     | Epicenter doesn't use Yjs subdocuments (providers don't support lifecycle management). One shared KV array is simpler.    |
| No secsync          | Application-level encryption     | secsync replaces Y-sweet entirely. Overkill when we control the relay and only need to encrypt values, not the full CRDT. |

## Implementation Plan

### Phase 1: Crypto module

A standalone module with no Yjs or Better Auth dependencies. Pure Web Crypto API.

- [ ] `deriveKek(password, salt)` — PBKDF2 → AES-GCM CryptoKey
- [ ] `generateMasterKey()` — `crypto.getRandomValues(new Uint8Array(32))`
- [ ] `wrapMasterKey(masterKey, kek)` / `unwrapMasterKey(wrapped, kek, iv)` — AES-GCM wrap/unwrap
- [ ] `encryptValue(plaintext, masterKey)` / `decryptValue(ciphertext, masterKey, iv)` — AES-GCM encrypt/decrypt with base64 I/O
- [ ] Tests: round-trip wrap/unwrap, round-trip encrypt/decrypt, same password + salt = same KEK across "devices"

### Phase 2: Better Auth integration

- [ ] Add `wrappedMasterKey`, `masterKeySalt`, `masterKeyIv`, `keyVersion` to user `additionalFields`
- [ ] Signup flow: intercept password client-side → generate master key → derive KEK → wrap → send wrapped key with signup request
- [ ] Login flow: receive wrapped key from user object → derive KEK from password → unwrap → hold master key in memory
- [ ] Password change flow: unwrap with old KEK → re-wrap with new KEK → update user record

### Phase 3: Vault service (KV integration)

- [ ] Define a `vault` KV schema via `defineKv` for the encrypted entries (`{ ct: string, iv: string }`)
- [ ] `VaultService` wrapping `kv.get` / `kv.set` that encrypts on write and decrypts on read
- [ ] Key naming convention: `apiKey:{provider}` (e.g., `apiKey:openai`)
- [ ] Observe KV changes to reactively decrypt when synced entries arrive from other devices

### Phase 4: UI

- [ ] API Keys settings page: list, add, edit, delete
- [ ] Masked input with reveal toggle
- [ ] Sync status indicator (encrypted, syncing, synced)

## Edge Cases

### Password change

Derive new KEK from new password, unwrap Master Key with old KEK, re-wrap with new KEK, update Postgres. Zero API keys need re-encryption. This should happen client-side during the password change flow, before the old password is discarded.

### Forgot password

If the user forgets their password, the wrapped Master Key is unrecoverable. All API keys are permanently lost. This is the fundamental trade-off of zero-knowledge encryption. See Open Questions for recovery options.

### Browser data cleared

No impact. The Master Key lives in Postgres (wrapped), not in the browser. User logs in again, password re-derives KEK, Master Key is unwrapped, Y-sweet re-syncs encrypted KV entries, everything recovers.

### Lost/stolen device

The attacker has encrypted KV entries in IndexedDB (if Y-sweet local persistence is enabled). Without the password, they can't derive the KEK, can't unwrap the Master Key, can't decrypt anything. The encrypted blobs are useless.

### Concurrent API key updates

Two devices update `apiKey:openai` simultaneously. `YKeyValueLww` resolves via timestamp: higher `ts` wins. Both devices converge. No corruption — the entire value (`{ ct, iv }`) is replaced atomically. The "loser" entry is deleted from the Y.Array.

### First-time vault setup (existing users)

Users who signed up before the vault feature don't have a wrapped Master Key. On first access to the vault UI, generate a Master Key, prompt for password (or re-use the current session's password if available), wrap and store. Lazy initialization.

## Open Questions

1. **Recovery mechanism**: A forgotten password means permanent loss of all API keys. Options:
   - (a) Generate a recovery code (like 1Password's Secret Key) shown once at setup
   - (b) Allow exporting an unencrypted backup (user's responsibility to secure it)
   - (c) Accept the risk — API keys can always be regenerated from the provider's dashboard
   - Recommendation: Start with (c). API keys are replaceable. Add (a) later if users request it.

2. **Password interception point**: Better Auth hashes passwords server-side. We need the plaintext client-side to derive the KEK. Options:
   - (a) Intercept in the login form's `onSubmit` before calling Better Auth
   - (b) Use a custom Better Auth plugin that exposes a client-side hook
   - (c) Prompt separately for "vault password" after login (defeats the UX goal)
   - Recommendation: (a) is simplest. Read the password field value in the form handler.

3. **Master key rotation**: If the Master Key is compromised, all API keys must be re-encrypted. Is this worth building now?
   - Recommendation: Defer. The Master Key is only ever in memory or wrapped. Compromise requires both DB access and the user's password.

4. **Per-app vs workspace-wide keys**: Should `apiKey:openai` be available to all Epicenter apps or scoped per-app?
   - Recommendation: Workspace-wide. That's the whole point — enter once, use everywhere. Scoping adds complexity with little benefit since all apps are first-party.

## Success Criteria

- [ ] API key encrypted with AES-GCM, stored in KV LWW, syncs to second device, decrypts correctly
- [ ] Server/DB inspection shows only ciphertext (no plaintext API keys anywhere)
- [ ] Password change re-wraps Master Key without re-encrypting individual keys
- [ ] New device login recovers all API keys via password + Y-sweet sync
- [ ] Browser data clear + re-login recovers all API keys

## References

- `packages/epicenter/src/shared/y-keyvalue/y-keyvalue-lww.ts` — LWW KV store. Generic over `T`, supports any Yjs-serializable value.
- `packages/epicenter/src/static/define-kv.ts` — KV schema definition with versioning and migration.
- `packages/epicenter/src/static/create-kv.ts` — Binds KV definitions to `YKeyValueLww` at runtime.
- `packages/epicenter/src/shared/ydoc-keys.ts` — Y.Doc key conventions (`kv`, `table:{name}`).
- `apps/epicenter/src/lib/yjs/y-sweet-connection.ts` — Y-sweet WebSocket provider setup.
- `specs/20260121T170000-sync-architecture.md` — Sync modes (local, self-hosted, cloud) and doc ID conventions.
