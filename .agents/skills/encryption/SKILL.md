---
name: encryption
description: Encryption patterns for HKDF key derivation, XChaCha20-Poly1305 symmetric encryption, encrypted blob formats, key hierarchy, and key rotation. Use when working with crypto primitives, encrypted CRDT values, key derivation, key rotation, or the EncryptedBlob type.
---

# Encryption Patterns

## Reference Repositories

When working with encryption, consult these repositories for patterns and documentation:

- [noble-ciphers](https://github.com/paulmillr/noble-ciphers) — Audited JS implementation of ChaCha, Salsa, AES (our crypto primitive library)
- [libsodium](https://github.com/jedisct1/libsodium) — Crypto primitives, secretbox/AEAD patterns, XChaCha20-Poly1305
- [Signal Protocol (libsignal)](https://github.com/signalapp/libsignal) — Key hierarchy, HKDF usage, Double Ratchet, message encryption
- [Vault Transit](https://developer.hashicorp.com/vault/docs/secrets/transit) — Key versioning, rotation, ciphertext format (`vault:v1:base64`)
- [Bitwarden](https://github.com/bitwarden/server) — Client-side vault encryption, key hierarchy (master key -> org key -> cipher key)
- [AWS KMS](https://docs.aws.amazon.com/kms/) — Envelope encryption patterns, key rotation lifecycle
- [age](https://github.com/FiloSottile/age) — Simple file encryption design philosophy

### What We Borrow From Each

| Concern | Inspiration | Why |
|---|---|---|
| Key derivation | Signal Protocol | HKDF-SHA256 with domain-separation info strings (unversioned, per RFC 5869) |
| Symmetric cipher | libsodium / WireGuard | XChaCha20-Poly1305: 2.3x faster in pure JS, 24-byte nonce safe for random generation |
| Key hierarchy | Bitwarden | Root secret -> per-user key -> per-workspace key |
| Key version in ciphertext | Tink / Vault | Key version byte prefix inside ct binary |
| Key rotation model | Vault Transit | Keyring with versioned secrets, lazy re-encryption |
| Design philosophy | age | Simplicity over configurability |

## Epicenter's Encryption Architecture

### Environment Variables

```bash
# Required. Completely independent from BETTER_AUTH_SECRET.
# Always uses versioned format: "version:secret" pairs, comma-separated.
# Generate secret: openssl rand -base64 32

# Single key (initial setup):
ENCRYPTION_SECRETS="1:base64encodedSecret"

# After rotation (add new version, keep old for decryption):
ENCRYPTION_SECRETS="2:newBase64Secret,1:oldBase64Secret"
```

- ONE env var: `ENCRYPTION_SECRETS` (always plural, always versioned format)
- Format: `version:secret` pairs, comma-separated. Highest version = current key for new encryptions.
- Completely decoupled from `BETTER_AUTH_SECRET`--rotating one never affects the other
- Matches Better Auth's own `BETTER_AUTH_SECRETS` convention

### Key Hierarchy

```
ENCRYPTION_SECRETS="1:base64Secret"
       |
       |  Parse -> keyring[{ version: 1, secret: "base64Secret" }]
       |  Current = highest version
       |
       |  SHA-256(currentSecret) -> root key material
       |  HKDF(root, info="user:{userId}") -> per-user key (32 bytes)
       v
  Session response -> client receives { encryptionKey, keyVersion }
       |
       |  HKDF(userKey, info="workspace:{wsId}") -> per-workspace key (32 bytes)
       v
  XChaCha20-Poly1305 encrypt/decrypt with @noble/ciphers
```

### Why XChaCha20-Poly1305 Over AES-256-GCM

| Concern | AES-256-GCM | XChaCha20-Poly1305 (chosen) |
|---|---|---|
| Performance (pure JS, 64B) | 201K ops/sec @ 4us | 468K ops/sec @ 2us (2.3x faster) |
| Nonce size | 12 bytes (collision risk with random) | 24 bytes (safe for random nonces) |
| Max messages per key (random nonce) | 2^23 (8M) | 2^72 (practically unlimited) |
| Nonce-reuse impact | Catastrophic (full key recovery) | Catastrophic (but 2^72 makes it irrelevant) |
| Used by | NIST, TLS 1.3 | libsodium, WireGuard, TLS 1.3, Noise Protocol |

AES-256-GCM via WebCrypto uses hardware AES-NI and is faster, but it's async. We need synchronous encrypt/decrypt for the CRDT hot path.

### Key Derivation

- Uses Web Crypto HKDF with SHA-256 hash
- Empty salt (acceptable for HKDF when input key material has high entropy)
- Info strings are domain-separation labels, NOT version identifiers
- `user:{userId}` for per-user keys, `workspace:{wsId}` for per-workspace keys
- Different secrets with the same info string produce cryptographically independent keys (RFC 5869)

### EncryptedBlob Format

```typescript
type EncryptedBlob = { v: 1; ct: Uint8Array };

// v:1 = XChaCha20-Poly1305 with key version byte
// ct binary layout:
//   ct[0]      = key version (which secret from ENCRYPTION_SECRETS keyring)
//   ct[1..24]  = random nonce (24 bytes)
//   ct[25..]   = XChaCha20-Poly1305 ciphertext || authentication tag (16 bytes)
```

- `v` field = blob format version AND discriminant for `isEncryptedBlob` detection
- `v: 1` means XChaCha20-Poly1305, key version byte at ct[0], 24-byte random nonce
- `ct[0]` = key version, identifying which secret encrypted this blob
- The `{ v, ct }` wrapper distinguishes encrypted from plaintext values in the CRDT
- Use `getKeyVersion(blob)` to read the key version without decrypting

### Key Rotation

```bash
# Rotate by adding a new highest-version entry:
ENCRYPTION_SECRETS="2:newBase64Secret,1:oldBase64Secret"
```

- Parser splits by `,`, then each entry by first `:` -> `{ version: number, secret: string }`
- Sorted by version descending; first entry = current for new encryptions
- Encrypt: always uses current (highest version) key, embeds version as ct[0]
- Decrypt: read ct[0] to know which key version was used, select matching key from keyring
- Lazy re-encryption: on read with non-current key version, re-encrypt on next write
- Keep old secrets in keyring for at least 90 days to handle offline devices

### Format Version Upgrade Path

- `v: 1` = XChaCha20-Poly1305 with key version byte prefix in ct

Format version bumps only needed for algorithm or binary layout changes (extremely rare):

| Scenario | Bumps `v`? |
|---|---|
| Secret rotation (new entry in ENCRYPTION_SECRETS) | No--key version in ct[0] handles this |
| Switch to different algorithm (unlikely) | Yes--different cipher |
| Add compression before encryption | Yes--different plaintext encoding |
| Change HKDF parameters (SHA-384, non-empty salt) | Yes--different key derivation |

### isEncryptedBlob Detection

```typescript
function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.v === 1 && obj.ct instanceof Uint8Array;
}
```

Do NOT use `Object.keys().length` checks--they are hostile to format evolution and have poor performance (allocates an array on every call).

### AAD (Additional Authenticated Data)

When encrypting workspace values, the entry key is bound as AAD to prevent ciphertext transplant attacks (moving an encrypted value from one key to another).
