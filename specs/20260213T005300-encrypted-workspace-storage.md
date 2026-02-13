# Encrypted Workspace Storage

**Date**: 2026-02-13
**Status**: Draft
**Supersedes**: `20260213T030000-encrypted-api-key-vault.md` (original was overengineered; see Analysis section)

## Overview

Optional value-level encryption for all workspace data stored in Yjs. When enabled, every value written to tables and KV is encrypted with AES-256-GCM before entering the Y.Doc. The CRDT structure remains intact (Y-Sweet can still merge), but the content is opaque.

Encryption is not just for API keys. Transcriptions, notes, chat histories, and settings are arguably more sensitive than replaceable API keys. If we're going to encrypt one thing, we should encrypt everything.

## How It Works (Plain English)

You get an encryption key one of three ways depending on your setup:

1. **Epicenter Cloud**: You log in. The server sends your encryption key over TLS. Done. You never think about it.
2. **Self-hosted / Local (opt-in)**: You set an encryption password in settings. Your browser derives a key from it using PBKDF2 (intentionally slow to resist brute-force). This only happens once per session.
3. **Self-hosted / Local (default)**: No encryption. Your device, your server, your data. OS-level disk encryption (FileVault, BitLocker, LUKS) and network-level encryption (Tailscale/WireGuard/TLS) are the right layers for this.

Once you have a key, every value is encrypted before it enters Yjs and decrypted when it comes out. The encryption layer sits between your application code and the Yjs document. Extensions (SQLite, markdown) see plaintext because they read through the same decrypt path.

## Architecture

### Encryption Layer Position

The encryption layer wraps table and KV operations. It sits between application code and the Y.Doc:

```
APPLICATION CODE
       │
       ▼
┌──────────────────────────────────┐
│      Encrypted Storage Layer      │
│                                   │
│  write(key, value):               │
│    if (encryptionKey) {           │
│      value = aesGcmEncrypt(value) │
│    }                              │
│    kv.set(key, value)             │
│                                   │
│  read(key):                       │
│    value = kv.get(key)            │
│    if (encryptionKey) {           │
│      value = aesGcmDecrypt(value) │
│    }                              │
│    return value                   │
│                                   │
└───────────────┬──────────────────┘
                │
                ▼
┌──────────────────────────────────┐
│         Y.Doc (CRDT)              │
│                                   │
│  Y.Array('table:posts')          │
│    { key: id, val: 'encrypted    │
│      blob or plaintext', ts }    │
│                                   │
│  Y.Array('kv')                   │
│    { key: 'apiKey:openai',       │
│      val: 'encrypted blob', ts } │
│                                   │
└───────────────┬──────────────────┘
                │
                ▼
┌──────────────────────────────────┐
│     Y-Sweet / Persistence         │
│                                   │
│  Sees CRDT structure (keys, ts)  │
│  Cannot read values (encrypted)  │
│  Can still merge (LWW on blobs)  │
└──────────────────────────────────┘
```

### What Y-Sweet Sees

With encryption enabled, Y-Sweet sees key names and timestamps but not values:

```
// Y-Sweet can see:
{ key: 'apiKey:openai',     val: { ct: 'aGVsbG8...', iv: 'abc123...' }, ts: 1706200000 }
{ key: 'apiKey:anthropic',  val: { ct: 'dG9rZW4...', iv: 'def456...' }, ts: 1706200001 }

// Table row:
{ key: 'post:abc',          val: { ct: 'ZW5jcnl...', iv: 'ghi789...' }, ts: 1706200002 }

// Y-Sweet can still:
// - Merge concurrent updates (LWW on the whole { ct, iv } blob)
// - Sync between devices (CRDT protocol is unaffected)
// - Garbage collect old entries
//
// Y-Sweet cannot:
// - Read the actual API key, post content, or any value
```

### Key Source by Sync Mode

```
┌─────────────────────────────────────────────────────────────┐
│                    ENCRYPTION KEY SOURCE                      │
│                                                               │
│  EPICENTER CLOUD                                             │
│  ────────────────                                            │
│  Login via Better Auth                                       │
│    → Server generates random AES-256 key per user            │
│    → Key stored on user record (server-side)                 │
│    → Sent to client over TLS on authentication               │
│    → Client holds key in memory for session                  │
│                                                               │
│  Password change: No-op for encryption (key lives on server) │
│  Forgot password: No-op for encryption (key lives on server) │
│  New device: Login → get key → decrypt synced data           │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  SELF-HOSTED (opt-in encryption)                             │
│  ───────────────────────────────                             │
│  User sets encryption password in app settings               │
│    → Password + PBKDF2 (600k iterations) → AES-256 key      │
│    → Key held in memory for session                          │
│    → Salt stored locally (per-device)                        │
│                                                               │
│  Password change: Re-encrypt all values (~50ms for 1000)     │
│  Forgot password: Re-enter API keys from provider dashboards │
│  New device: Enter same password on new device               │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  LOCAL (opt-in encryption)                                   │
│  ─────────────────────────                                   │
│  Same as self-hosted opt-in                                  │
│  Most users won't enable this (OS disk encryption suffices)  │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  LOCAL / SELF-HOSTED (default)                               │
│  ─────────────────────────────                               │
│  No encryption. Values stored as plaintext in Yjs.           │
│  Protected by OS-level disk encryption + network encryption. │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Cross-Device Sync (Cloud Mode)

```
DEVICE A (Origin)                 SERVER / DATABASE                DEVICE B (New)
─────────────────                 ─────────────────                ──────────────

1. Login
2. Receive encryption key ◄──── [ Postgres: user.encryptionKey ]
3. Encrypt values
4. Store in KV ──────────────▶  [ Y-sweet: encrypted blobs ]

                                 [ Postgres ] ────────────────▶ 5. Login
                                                                6. Receive encryption key
                                 [ Y-sweet  ] ────────────────▶ 7. Sync encrypted KV
                                                                8. Decrypt values
```

## Performance

AES-GCM is hardware-accelerated on modern CPUs (AES-NI). The overhead is negligible:

| Operation                             | Data Size  | Time              | Impact                     |
| ------------------------------------- | ---------- | ----------------- | -------------------------- |
| Encrypt 1 value                       | ~100 bytes | ~0.01ms           | Imperceptible              |
| Encrypt 1 table row                   | ~1-10 KB   | ~0.01-0.05ms      | Imperceptible              |
| Encrypt 100 values on bulk load       | ~100 KB    | ~1-5ms            | Imperceptible              |
| Encrypt 1,000 values on full sync     | ~1 MB      | ~10-50ms          | Barely noticeable          |
| PBKDF2 key derivation (once at login) | N/A        | ~500-1000ms       | One-time cost              |
| SQLite materialization with decrypt   | 1,000 rows | ~10-50ms overhead | Negligible vs rebuild cost |

The only perceptible cost is PBKDF2 key derivation, which happens once per session (self-hosted/local opt-in only). Cloud users never experience this.

## Data Flow Through Extensions

The critical insight: extensions like SQLite read through the same table/KV helpers. If those helpers decrypt transparently, extensions get plaintext without any changes:

```
Yjs (encrypted values)
       │
       ▼ table.observe() fires
       │
       ▼ table.get(id) → decrypt → plaintext row
       │
       ▼ SQLite extension inserts plaintext into local .db
       │
       ▼ Drizzle queries work on plaintext SQLite
```

SQLite is a local materialized view on the user's device. Storing plaintext in the local SQLite is correct because:

- SQLite is never synced (it's rebuilt from Yjs on each device)
- The user's device is trusted (same as OS filesystem)
- Queries need plaintext to work (you can't WHERE on ciphertext)

The same applies to markdown extension, revision history snapshots, and any future extensions.

## Design Decisions

| Decision                     | Choice                                | Rationale                                                                                                                  |
| ---------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Encryption scope             | All values, not just API keys         | Uniform security model. Transcriptions and notes are more sensitive than replaceable API keys. Marginal cost is near zero. |
| Encryption layer             | Value-level (inside CRDT)             | Y-Sweet can still merge. Structure visible, content opaque. No sync protocol changes.                                      |
| No KEK / Master Key wrapping | Direct key usage                      | KEK exists to make password changes cheap. Re-encrypting 1000 values takes ~50ms. Not worth the complexity for our scale.  |
| Cloud key source             | Server-held per-user key              | Eliminates password interception, password change, and forgot-password problems entirely. Login IS the encryption gate.    |
| Self-hosted encryption       | Opt-in via password                   | Most self-hosted users are on Tailscale. Don't add friction for the common case.                                           |
| Local encryption             | Opt-in via password                   | OS disk encryption is the right layer. App-level encryption is a nice-to-have.                                             |
| Algorithm                    | AES-256-GCM via Web Crypto API        | Native browser support, hardware accelerated, authenticated encryption. No external dependencies.                          |
| Key derivation               | PBKDF2, 600k iterations, SHA-256      | Only KDF natively in Web Crypto API. 600k is OWASP 2024+ recommendation. Argon2 not yet in browsers.                       |
| IV management                | Random 12-byte IV per encryption      | Stored alongside ciphertext. Never reused. Standard AES-GCM practice.                                                      |
| Encrypted value format       | `{ ct: string, iv: string }` (base64) | Compatible with KV LWW and table value storage. Safe for JSON serialization.                                               |

## What Was Eliminated (vs Original Spec)

The original spec (`20260213T030000-encrypted-api-key-vault.md`) used a 3-layer encryption hierarchy (Password → KEK → Master Key → Encrypted Values). This simplified spec eliminates:

| Eliminated                                                                     | Why                                                                                                       |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| KEK (Key Encryption Key) layer                                                 | Only purpose was cheap password changes. Re-encrypting 1000 values is ~50ms. Not worth the complexity.    |
| Master Key generation                                                          | No master key needed. The encryption key IS the key.                                                      |
| Wrap/unwrap operations                                                         | No wrapping layer.                                                                                        |
| `wrappedMasterKey`, `masterKeySalt`, `masterKeyIv`, `keyVersion` on user table | Cloud mode: server stores raw key. Self-hosted: salt stored locally.                                      |
| Password interception at login (Open Question #2)                              | Cloud: password has nothing to do with encryption. Self-hosted: separate encryption password in settings. |
| Password change re-wrap flow                                                   | Cloud: no-op. Self-hosted: re-encrypt all (~50ms).                                                        |
| "Forgot password = permanent loss" footgun                                     | Cloud: key on server, just reset password. Self-hosted: API keys are replaceable.                         |
| Zero-knowledge requirement for all modes                                       | Only self-hosted opt-in provides zero-knowledge. Cloud trusts the server (users already trust the relay). |

**Complexity reduction**: ~60-70% of the original spec's crypto work is eliminated.

## Implementation Plan

### Phase 1: Crypto Module

Pure Web Crypto API functions. No Yjs or framework dependencies.

- [ ] `generateEncryptionKey()` — `crypto.getRandomValues(new Uint8Array(32))`
- [ ] `deriveKeyFromPassword(password, salt)` — PBKDF2 → AES-GCM CryptoKey
- [ ] `encryptValue(plaintext, key)` → `{ ct: string, iv: string }`
- [ ] `decryptValue({ ct, iv }, key)` → plaintext string
- [ ] `serializeKey(key)` / `deserializeKey(raw)` — for server storage/transport
- [ ] Tests: round-trip encrypt/decrypt, same password + salt = same key, unique IV per encryption

### Phase 2: Encrypted Storage Layer

A wrapper that intercepts table and KV operations to encrypt/decrypt transparently.

- [ ] `createEncryptedTables(tables, encryptionKey?)` — wraps table helpers with encrypt-on-write, decrypt-on-read
- [ ] `createEncryptedKv(kv, encryptionKey?)` — wraps KV helpers with encrypt-on-write, decrypt-on-read
- [ ] When `encryptionKey` is `undefined`, pass through without encryption (the default/no-encryption case)
- [ ] Ensure `table.observe()` callbacks still work (observers fire on the encrypted Y.Doc, extensions read through the decrypt wrapper)
- [ ] Tests: write encrypted → read decrypted, no-key passthrough, observer fires correctly

### Phase 3: Key Source Integration

Where the encryption key comes from, per sync mode.

- [ ] **Cloud**: Add `encryptionKey` field to user record via Better Auth `additionalFields`. Server generates on signup. Client receives on login.
- [ ] **Self-hosted / Local opt-in**: Settings UI for encryption password. Derive key via PBKDF2. Store salt in app settings (local only, not synced).
- [ ] **Self-hosted / Local default**: No encryption. No key. Passthrough mode.
- [ ] Hold derived/received key in memory for the session duration. Clear on logout/close.

### Phase 4: Workspace Integration

Wire the encryption layer into the workspace creation flow.

- [ ] `createWorkspace(definition).withEncryption(key?)` or pass encryption key via extension context
- [ ] Extensions (SQLite, markdown, persistence) continue to work unchanged — they read through the encrypted table/KV wrappers
- [ ] Migration path for existing unencrypted data: on first encryption setup, read all plaintext values and re-write as encrypted

### Phase 5: UI

- [ ] API Keys settings page: list, add, edit, delete (reads/writes through encrypted KV)
- [ ] Encryption status indicator in settings
- [ ] Self-hosted: encryption password setup/entry
- [ ] Cloud: automatic, no UI needed beyond showing "encrypted" badge

## Edge Cases

### Self-hosted: Password change

Derive new key from new password. Read all values with old key, re-encrypt with new key, write back. For 1000 values this takes ~50ms. No separate wrapping layer needed.

### Self-hosted: Forgot encryption password

API keys are replaceable (regenerate from provider dashboards in seconds). Other data (transcriptions, notes) is in the local Yjs persistence — if the user has the `.yjs` file, the data is there in the CRDT. The encryption only affects the synced representation. Local persistence can optionally store unencrypted.

### Cloud: Forgot login password

No impact on encryption. The encryption key lives on the server, tied to the user account. Password reset via Better Auth recovers account access, and the encryption key is still there.

### Browser data cleared

No impact. Cloud: log in again, get key from server, Y-Sweet re-syncs encrypted data, decrypt. Self-hosted: enter encryption password again, derive key, local persistence reloads.

### Mixed encrypted/unencrypted devices

If Device A has encryption enabled and Device B doesn't, Device B will see encrypted blobs as raw `{ ct, iv }` objects instead of plaintext values. The application should detect this (check if value has `ct` and `iv` fields) and prompt for the encryption key.

### Concurrent updates

Two devices encrypt the same key simultaneously with different values. LWW resolves by timestamp — the higher `ts` wins. Both devices converge on the same ciphertext. The "loser" is overwritten. No corruption because the entire `{ ct, iv }` blob is replaced atomically.

### Migration: Existing unencrypted data

On first encryption setup, the application reads all existing plaintext values, encrypts them, and writes them back. This is a one-time migration. For 1000 values, ~50ms.

## Open Questions

1. **Key storage for cloud mode**: Should the encryption key be stored directly on the user record, or in a separate table? Direct is simpler; separate allows per-workspace keys later.
   - Recommendation: Direct on user record. One key per user. Per-workspace keys can be added later if needed.

2. **Selective encryption**: Should users be able to choose which workspaces are encrypted? Or all-or-nothing?
   - Recommendation: All-or-nothing per sync mode. Cloud = always encrypted. Self-hosted = user chooses once. Reduces configuration surface.

3. **Key rotation**: If the cloud encryption key needs to be rotated (admin action, security incident), all values must be re-encrypted. Worth building now?
   - Recommendation: Defer. Add a `keyVersion` field to the user record for future-proofing, but don't build rotation logic yet.

## Self-Hosted Deployment Context

For context on why self-hosted encryption is opt-in rather than required:

**Typical self-hosted setup (lowest friction)**:

- Y-Sweet server running on home machine or VPS
- Accessible via Tailscale (WireGuard-encrypted mesh VPN, zero config)
- Only user's devices can reach the server
- Data in transit: encrypted by WireGuard
- Data at rest: protected by OS disk encryption on the server

**Other self-hosted options**:

- Cloudflare Tunnel (public URL with access policies, zero ports opened)
- Direct reverse proxy (nginx/Caddy with TLS + Y-Sweet token auth)
- ZeroTier, Headscale, plain WireGuard

In all these cases, the user controls the server. Client-side encryption protects against server compromise, but for someone running Y-Sweet on their Tailscale network, server compromise risk is near zero. Hence: opt-in.

## Success Criteria

- [ ] Value encrypted with AES-GCM, stored in Yjs, syncs to second device, decrypts correctly
- [ ] Y-Sweet inspection shows only ciphertext (no plaintext values anywhere in the CRDT)
- [ ] SQLite extension materializes decrypted plaintext correctly
- [ ] Cloud mode: login on new device recovers all data via server-held key
- [ ] Self-hosted opt-in: same password on two devices yields same key and can decrypt each other's data
- [ ] No encryption mode: everything works exactly as it does today (zero overhead)
- [ ] Encryption overhead: < 50ms for 1000 values on bulk operations

## References

- `packages/epicenter/src/dynamic/workspace/create-workspace.ts` — Workspace creation, extension wiring
- `packages/epicenter/src/dynamic/tables/create-tables.ts` — Table helper creation
- `packages/epicenter/src/dynamic/kv/create-kv.ts` — KV helper creation
- `packages/epicenter/src/extensions/sqlite/sqlite.ts` — SQLite materialization (reads through table helpers)
- `packages/epicenter/src/static/define-kv.ts` — KV schema definition
- `packages/epicenter/src/shared/y-keyvalue/y-keyvalue-lww.ts` — LWW KV store
- `specs/20260121T170000-sync-architecture.md` — Sync modes (local, self-hosted, cloud)
- `specs/20260213T030000-encrypted-api-key-vault.md` — Original spec (superseded)

## Analysis: Why the Original Spec Was Overengineered

The original spec used a 3-layer encryption hierarchy (Password → KEK → Master Key → Encrypted Values) borrowed from enterprise key management systems (Google Cloud KMS, 1Password). This pattern exists to solve three problems:

1. **Cheap password changes** (re-wrap one master key, not re-encrypt all data)
2. **Multiple authentication methods** (biometric, hardware key each wrap the same master key)
3. **Key rotation without re-encryption** (rotate master key, re-wrap with KEK)

None of these apply to Epicenter at current scale:

- Password changes: re-encrypting 1000 values takes ~50ms. No optimization needed.
- Multiple auth methods: not planned.
- Key rotation: deferred. Can be added later without changing the encryption layer.

The KEK layer was ~60-70% of the original spec's complexity (PBKDF2 derivation, wrap/unwrap operations, password interception at login, salt management, additional database fields). Removing it cuts implementation time roughly in half while maintaining the same security properties for the actual threat model.

Additionally, requiring zero-knowledge encryption for all deployment modes was unnecessary. Cloud users already trust the Epicenter relay (stated in the sync architecture spec). Self-hosted users own their server. Gating encryption behind login for cloud (server-held key) eliminates the hardest UX problems: password interception, forgot-password-loses-everything, and password change flows.
