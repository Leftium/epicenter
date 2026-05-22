# Cloud Asset Model: Encrypted Blobs on a Dumb Store

**Date**: 2026-05-22
**Status**: Draft; Phase 0 verified against code, Open Questions resolved (2026-05-22)
**Author**: AI-assisted
**Branch**: braden-w/cloud-sync-overhaul

> Greenfield spec. Grep on 2026-05-22 confirmed zero references to `api/assets`
> or `assetId` anywhere outside `apps/api`: no client builds, persists, or
> consumes an asset URL today. The asset model can be defined from scratch with
> no migration. This spec is a companion to
> `specs/20260522T220000-api-runtime-portability.md`, which owns the runtime
> `AssetStore` abstraction; this spec owns the confidentiality model on top of
> it. This spec changes neither the `AssetStore` contract nor the
> `subject:<userId>:rooms:<guid>` key grammar.

## Overview

Today an Epicenter cloud asset (an image or PDF embedded in a document) is
stored in plaintext and served from an unauthenticated capability URL. This
spec changes the asset to a client-side-encrypted blob: the client encrypts at
asset creation with the embedding document's per-workspace key, the server
stores ciphertext, and the client fetches and decrypts. The asset becomes
consistent with the rest of Epicenter, where a document is encrypted and "can
you see it" means "can you decrypt it."

## One-sentence thesis

> An asset is encrypted client-side at creation with the same per-workspace key
> its embedding document uses; the server stores and serves opaque ciphertext,
> and the asset URL is a pointer, not a credential.

## Design Review (2026-05-22)

A grilling pass against the real code corrected and sharpened the draft. The
changes folded into this revision:

1. **Key scope corrected: per-workspace, not per-subject.** The draft said
   "encrypt with the subject keyring." Documents do not do that. `attachEncryption`
   derives a per-workspace key (`deriveWorkspaceKey(subjectKey, workspaceId)`,
   HKDF info `workspace:{id}`) and the encrypted YKeyValue stores use it. For an
   asset to be *exactly* as private as the document that embeds it, and to truly
   "reuse the document key path," it must encrypt under the embedding document's
   workspace key. See Phase 0 Findings and Design Decisions.
2. **`attachEncryption` is not the entry point.** Phase 0.2 of the draft asked
   to confirm `attachEncryption` can encrypt an arbitrary `Uint8Array`. It
   cannot: its surface is `attachTable / attachTables / attachKv` only, a
   Y.Doc-scoped coordinator. The arbitrary-bytes primitive is `encryptBytes` /
   `decryptBytes` in `@epicenter/encryption`. The asset path calls those
   directly.
3. **Encryption is a creation-time step, not an upload-time step.** A blob is
   encrypted once when the asset is created; "upload" transports already-formed
   ciphertext and never re-encrypts. This makes a local-only asset (Tier 3) and
   its later promotion to a synced asset (Tier 1) a byte-identical copy.
4. **The read route must drop HTTP range support.** A whole-blob AEAD ciphertext
   cannot be partially decrypted, so a `Range` 206 response returns undecryptable
   bytes. The current route advertises `accept-ranges` and honours `Range`;
   keeping that on an encrypted asset is an active bug. ETag / 304 / immutable
   caching stay (they work over ciphertext). Folded into Phase 1.3.
5. **The "unauthenticated read" reasoning was wrong and is replaced.** The draft
   justified it with "auth breaks cross-origin embedding." You cannot embed
   ciphertext in an `<img>` regardless, so every render is a JS `fetch` that
   *could* carry a credential. The decision stands (keep it unauthenticated) but
   on honest grounds; see Open Questions.

## Motivation

### Current State

Asset read is fully unauthenticated. `app.ts` mounts `assetPublicRoutes` before
any auth middleware:

```ts
// apps/api/src/app.ts:374-376
// Asset reads: unauthenticated (unguessable URL is the credential).
app.route('/api/assets', assetPublicRoutes);
```

```ts
// apps/api/src/asset-routes.ts — the asset is stored and served in plaintext
await c.env.ASSETS_BUCKET.put(key, file.stream(), {
  httpMetadata: { contentType: file.type, /* ... */ },
});
// ...read path returns object.body verbatim, no decryption, no auth check,
// and advertises accept-ranges + honours Range with a 206 response.
```

This creates problems:

1. **Anyone, not just signed-in users, can read any asset given its URL.** The
   credential is the unguessable id (~77 bits). That defeats *guessing*, but the
   URL itself leaks: Referer headers, browser history, server and proxy logs,
   chat messages. The W3C TAG capability-URL guidance treats leakage as the
   primary risk and recommends expiry, which this design has none of.
2. **The asset is plaintext at rest.** Anyone who reads the blob store, the
   filesystem, the R2 bucket, or a database backup reads the image. The
   document that embeds it is encrypted; the image inside it is not.
3. **It contradicts the product's own claim.** `docs/articles/20260522T210000-an-organization-is-a-deployment.md`
   says "Each document is encrypted, so 'can you see it' really means 'can you
   decrypt it.'" An embedded image silently breaks that sentence. A user who
   trusts an encrypted note does not expect its screenshot to be a plaintext
   blob behind a shareable link.

### Desired State

The asset is `EncryptedBlob` ciphertext. The capability URL points at
ciphertext. Reading the URL without the embedding document's workspace key
yields unreadable bytes. The unauthenticated read endpoint becomes safe,
because an open endpoint that serves only ciphertext discloses no content.

```
creation:  file --encrypt(workspaceKey)--> EncryptedBlob   (once, at creation)
upload:    POST /api/assets  body = EncryptedBlob           (transports ciphertext)
server:    AssetStore.put(assetId, ciphertext)              (dumb store, never sees plaintext)
read:      GET /api/assets/<assetId> --> ciphertext --decrypt(workspaceKey)--> file
```

## Phase 0 Findings (verified against code, 2026-05-22)

The encryption primitive was read directly, not assumed. Findings:

### `EncryptedBlob` format (`packages/encryption/src/blob.ts`)

```
byte 0      format version            always 1
byte 1      key version               1..255  (selects a key from the keyring)
bytes 2..25 XChaCha20 nonce           24 bytes, random per blob
bytes 26..  ciphertext + Poly1305 tag  variable; tag is the trailing 16 bytes
            HEADER_LENGTH = 2   NONCE = 24   TAG = 16   MIN BLOB = 42 bytes
```

- `EncryptedBlob = Uint8Array & Brand<'EncryptedBlob'>`.
- Cipher: `xchacha20poly1305(key, nonce, aad?)` from `@noble/ciphers` v2. The
  key must be exactly 32 bytes (asserted at every entry point).
- `encryptBytes({ key, keyVersion, plaintext: Uint8Array, aad? })` produces an
  `EncryptedBlob` from **arbitrary bytes**. `decryptBytes({ keyring, blob, aad? })`
  selects the key by the blob's version byte and decrypts.
- **The AEAD is one-shot over the whole buffer. No chunked or streamed framing
  exists**, and noble v2 exposes no incremental AEAD. A blob is atomic: every
  byte plus the trailing tag is required to verify or decrypt any of it. This
  decides Open Question 1 (whole-blob is the only thing that exists; chunked
  framing would be a new format, format-version byte `2`).

### Arbitrary-bytes encryption: the primitive, not `attachEncryption`

- `encryptBytes` / `decryptBytes` are documented as the "storage-level sibling
  to `encryptValue`": they encrypt and decrypt any `Uint8Array`. An asset is
  just bytes, so these are the correct functions and **no new crypto is needed**.
- **`attachEncryption` (`packages/workspace`) cannot encrypt arbitrary bytes.**
  Its `EncryptionAttachment` surface is exactly `attachTable`,
  `attachReadonlyTable`, `attachTables`, `attachReadonlyTables`, `attachKv`. It
  is a Y.Doc-scoped coordinator for encrypted YKeyValue stores; there is no
  `encryptBlob` / `decryptBlob` method. The asset path does **not** go through
  `attachEncryption`.

### The key: per-workspace, derived from the subject keyring

- The API delivers a `SubjectKeyring` (one `{ version, subjectKeyBase64 }` per
  root-keyring version) to the client through the auth-session response.
  `deriveSubjectKeyring` derives it from `ENCRYPTION_SECRETS` server-side.
- Documents do **not** encrypt with the subject key. `attach-encryption.ts`
  calls `deriveWorkspaceKeyring(subjectKeyring, workspaceId)`, which derives one
  32-byte key per version via `deriveWorkspaceKey(subjectKey, workspaceId)`
  (HKDF, info label `workspace:{workspaceId}`). The encrypted YKeyValue stores
  use that per-workspace keyring.
- Therefore an asset reuses the document key path only if it encrypts under the
  **embedding document's workspace key**. The workspace id is the embedding
  Y.Doc's `guid`; the client editing that document already holds it.

### Key hierarchy, and the absence of key wrapping

```
ENCRYPTION_SECRETS (ENV)  --parseRootKeyring-->  RootKeyring        server only
  --deriveSubjectKeyring(subject=userId)-->      SubjectKeyring     to the client
  --deriveWorkspaceKey(subjectKey, workspaceId)--> 32-byte key      per workspace
```

Every arrow is an HKDF (or SHA-256+HKDF) derivation. No key is ever wrapped
under another key, and no key material is stored anywhere except
`ENCRYPTION_SECRETS` in the deployment's ENV. This is consistent with the
ownership model's explicit refusal of key wrapping and escrow: the asset model
introduces neither.

## Research Findings

### Capability URLs (W3C TAG, "Good Practices for Capability URLs")

A capability URL grants access to anyone holding it. It is a legitimate,
widely-used pattern (Google Drive "anyone with the link", Discord CDN, Dropbox
links). The documented risks are all **leakage**: the `Referer` header, browser
history, logs, third-party scripts. Recommended mitigations: HTTPS, **expiry**,
and putting the secret in the URL fragment (which does not help here, because a
fetched resource URL sends its whole path).

**Key finding**: a capability URL is acceptable only when the thing it points
at is either genuinely public or itself unreadable without a separate secret.
Epicenter's assets are neither today.

### How encrypted-attachment products work (DeepWiki, 2026-05-22)

| Product | Blob on the store | Encryption | Where the key lives | URL |
| --- | --- | --- | --- | --- |
| Signal (`signalapp/libsignal`) | Ciphertext | `AES-256-GCM-SIV`, client-side | In the message's `LocatorInfo`, delivered with the (encrypted) message | CDN pointer to ciphertext |
| Bitwarden (`bitwarden/server`) | Ciphertext | Client-side before upload | Per-attachment `key` in `CipherAttachment.MetaData`, returned via the authenticated metadata API | Pre-signed capability URL to ciphertext |

**Key finding**: both store **ciphertext on a dumb blob store** and never rely
on URL secrecy for confidentiality. The URL is a pointer; the key is delivered
separately through an already-trusted channel. This is the standard model for
private attachments.

**Implication for Epicenter**: Epicenter does not need Signal's
per-attachment-key-in-message machinery. Signal needs it because an attachment
is shared with other users. An Epicenter asset is owned by one subject
(`subject:<userId>`) and embedded in one document, exactly like the document's
own fields, and the client already holds that document's workspace key. The
asset reuses the document key path verbatim: no per-asset key, no escrow, no key
wrapping. This matches the ownership model's explicit refusal of key wrapping
and escrow.

## Threat Model

What encrypted assets defend against, and what they do not.

| Adversary | Defended | By what |
| --- | --- | --- |
| Internet user with a guessed or leaked URL | Content yes; existence and size no | Ciphertext (no workspace key) plus the unguessable id. The body is unreadable; the response still discloses that a blob of ~plaintext size exists |
| Theft of the blob store, filesystem, R2 bucket, or a DB backup, without `ENCRYPTION_SECRETS` | Yes | Ciphertext at rest; the `asset` row holds no content type or filename |
| CDN, proxy, or third-party log processor that captured the URL | Content yes | The URL points at ciphertext; such a party can fetch the blob and learn its size, nothing more |
| Another signed-in user of the same deployment | Yes | Per-workspace key: their session delivers only their own subject keyring, from which they cannot derive another subject's workspace key. They can fetch the ciphertext; they cannot decrypt it |
| Deployment operator holding `ENCRYPTION_SECRETS` (a managed deployment) | No | By design. Same as documents. The ownership model states managed deployments can read their data; self-hosted are vendor-blind because the org alone holds `ENCRYPTION_SECRETS` |
| Observer of blob size or upload timing | No | Metadata is not hidden; padding is out of scope (see Open Questions) |

The model is identical to the document model. An asset is no more and no less
private than the document that embeds it. That is the point.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Asset confidentiality | 2 coherence | Client-side encrypted; the server stores ciphertext | Makes the asset consistent with the encrypted document; Signal and Bitwarden precedent |
| Encryption key | 2 coherence | The embedding document's **per-workspace** key, `deriveWorkspaceKey(subjectKey, workspaceId)` | Phase 0: this is the exact key the document's YKeyValue stores use; an asset is then literally as private as its document, and rotation/versioning work identically. Not the raw subject key |
| Encryption primitive | 1 evidence | `encryptBytes` / `decryptBytes` from `@epicenter/encryption`, called directly | Phase 0: these encrypt arbitrary `Uint8Array`; `attachEncryption` has no arbitrary-bytes method and is not used |
| When encryption happens | 2 coherence | Once, at asset creation; "upload" transports already-formed ciphertext | Local-only (Tier 3) and synced (Tier 1) hold byte-identical ciphertext; promotion is a copy, never a re-encrypt |
| Cipher + blob format | 1 evidence | XChaCha20-Poly1305, `EncryptedBlob` format version 1 (see Phase 0 Findings) | Reuse the package documents already use; format verified, not assumed |
| `aad` binding | 3 taste | `aad = utf8(assetId)` when the id is known at encrypt time | Mirrors the document path's `aad = entryKey`; binds a ciphertext to its slot so two assets in one workspace cannot be silently swapped. Defense in depth: the workspace key already isolates across workspaces |
| `assetId` generation | 2 coherence | Client-generated 15-char id (was server-minted) | Lets the client know `assetId` at encrypt time (enables the `aad` binding) and reference the asset in the document optimistically. PK conflict => 409; negligible at ~2^77. If Phase 1 keeps a server-minted id, omit `aad` |
| Unauthenticated read endpoint | 2 coherence | Keep it unauthenticated | Once the body is ciphertext, an open endpoint discloses only ciphertext plus size; the `assetId` exists only inside an encrypted document, so any legitimately-scoped reader already holds the key. See Open Questions for the honest trade |
| HTTP range requests | 1 evidence | Removed from the encrypted read (was: `Range` honoured) | Phase 0: a whole-blob AEAD ciphertext cannot be range-decrypted, so a 206 returns undecryptable bytes. Keep ETag / 304 / immutable caching |
| Unguessable `assetId` | 3 taste | Keep the 15-char random id | Defense in depth: stops enumeration of ciphertext blobs and their sizes; near-free |
| Asset URL shape | 2 coherence | `/api/assets/<assetId>`, no `userId` | Owned by the portability spec; this spec does not change it |
| Server-side metadata | 2 coherence | The `asset` row keeps `id`, `userId`, `ciphertextBytes`, `uploadedAt`. `contentType` and `originalName` move into the encrypted document | A server-stored `contentType` would be an unvalidated client claim (the server cannot sniff ciphertext); `originalName` leaks as much as content. Shrinks operator-visible metadata to what billing and quota need |
| MIME allow-list + size gate | 2 coherence | MIME check moves client-side; the byte-size and billing gates run server-side on the ciphertext | The server cannot sniff ciphertext. The XSS vector a server allow-list defended is already closed by ciphertext + `application/octet-stream` + `nosniff` + a client-chosen Blob type (see Edge Cases) |
| Billing meter | 2 coherence | Meter the ciphertext byte length the server receives | Storage billing should bill what is actually stored; ciphertext is plaintext + 42 bytes of overhead |
| Public / plaintext asset tier | Deferred | Refused for v1 | The ownership model refuses in-app sharing; no public-document feature exists, so nothing needs a public asset |
| Local-only assets (never uploaded) | 2 coherence | Supported as the strongest tier | Local-first: an asset may stay in the local workspace store and never sync |

## Architecture

### The encryption is one step, at creation

```
asset creation (client)
────────────────────────
  file (image/pdf)
    --> validate MIME + size client-side
    --> assetId = generateGuid()                       (15-char, client-side)
    --> workspaceKey = deriveWorkspaceKey(subjectKey, embeddingDoc.guid)
    --> EncryptedBlob = encryptBytes({
          key: workspaceKey, keyVersion: newest,
          plaintext: fileBytes, aad: utf8(assetId) })
    --> store the EncryptedBlob locally (workspace store)

The EncryptedBlob now exists. Every later step moves these exact bytes; nothing
re-encrypts.
```

### Upload (Tier 1)

```
POST /api/assets        body = EncryptedBlob (raw bytes, application/octet-stream)
  --> billing + quota gate on the ciphertext byte length
  --> AssetStore.put(assetId, ciphertext)              (R2 or filesystem; opaque bytes)
  --> asset row { id: assetId, userId, ciphertextBytes, uploadedAt }
  --> 201 { assetId }
  (on metadata-write failure: compensating AssetStore.delete, no orphan billing)

reference (already done at creation, in the encrypted Y.Doc):
  { assetId, contentType, originalName }
  the server never sees contentType or originalName
```

The upload accepts a **raw ciphertext body**, not multipart. The server streams
`request.body` straight into `AssetStore.put`; it never buffers the blob and
never parses a `File`. This also retires the server-side memory concern noted on
`MAX_ASSET_BYTES`.

### Download and render

```
client has, from the decrypted Y.Doc:  assetId, contentType
  --> GET /api/assets/<assetId>          (unauthenticated; returns ciphertext)
        response: application/octet-stream, ETag, cache-control immutable,
                  x-content-type-options nosniff, no Accept-Ranges
  --> workspaceKey = deriveWorkspaceKey(subjectKey, embeddingDoc.guid)
  --> plaintext = decryptBytes({
        keyring: deriveWorkspaceKeyring(subjectKeyring, embeddingDoc.guid),
        blob, aad: utf8(assetId) })       (selects the key by the blob version byte)
  --> new Blob([plaintext], { type: contentType })   (type chosen by the client)
  --> URL.createObjectURL(blob)  -->  <img src="blob:...">   (revoke on unmount)
```

`AssetStore` (owned by the portability spec) does not change: it stores and
serves opaque bytes and neither knows nor cares that they are ciphertext.

### The tiers, honestly named

```
TIER 1  encrypted cloud asset      DEFAULT. ciphertext synced to the deployment.
                                   decryptable by the owning subject's clients.

TIER 2  external store             same ciphertext, the org points AssetStore at
                                   its own S3-compatible bucket. a config choice,
                                   not a different security model.

TIER 3  local-only asset           never uploaded. the EncryptedBlob lives only
                                   in the local workspace store. the only tier
                                   that hides the blob's existence and size from
                                   the server. promotion to Tier 1 is a byte copy.

REFUSED  public plaintext asset    no in-app sharing exists to need it.
```

P2P transfer (WebRTC data channels) was considered for Tier 3 availability and
rejected: it requires both peers online, which defeats the reason a sync server
exists. Tier 3 is local persistence, not a transport.

## Implementation Plan

### Phase 0: Encryption primitive (VERIFIED 2026-05-22)

- [x] **0.1** `EncryptedBlob` format, the XChaCha20-Poly1305 API, and the
  chunked-framing question: see Phase 0 Findings. Format version 1, one-shot
  whole-buffer AEAD, no streaming primitive. Open Question 1 decided.
- [x] **0.2** Arbitrary-`Uint8Array` encryption: `encryptBytes` / `decryptBytes`
  in `@epicenter/encryption` do this. `attachEncryption` does **not** (no
  arbitrary-bytes method); the asset path calls the primitive directly. The key
  is the per-workspace key, not the subject key.

### Phase 1: Server stores ciphertext

- [ ] **1.1** Change the upload route to accept a raw ciphertext body; drop
  multipart parsing. Stream `request.body` into `AssetStore.put`. Remove the
  server-side MIME sniff. Keep the ciphertext byte-size gate, the billing gate
  (now metering ciphertext bytes), and the compensating delete on metadata-write
  failure.
- [ ] **1.2** Trim the `asset` table to `id`, `userId`, `ciphertextBytes`,
  `uploadedAt`. Drop `contentType` and `originalName` from the server row.
- [ ] **1.3** Serve the read route with `Content-Type: application/octet-stream`;
  keep the unauthenticated mount, the unguessable `assetId`, `ETag` / `304`, and
  `cache-control: immutable`. **Remove `Accept-Ranges`, the `Range` handling,
  and the 206 path** (a ciphertext range is undecryptable). Drop
  `Content-Disposition` (the filename now lives in the document).

### Phase 2: Client encrypts, references, decrypts

- [ ] **2.1** At asset creation: validate MIME and size client-side, generate
  `assetId`, derive the embedding document's workspace key, and
  `encryptBytes` the file under the newest keyring version with
  `aad = utf8(assetId)`. Store the `EncryptedBlob` in the local workspace store.
- [ ] **2.2** Store `{ assetId, contentType, originalName }` in the encrypted
  document, not in a server row.
- [ ] **2.3** Upload transports the existing `EncryptedBlob`; it does not
  re-encrypt.
- [ ] **2.4** On render: fetch ciphertext, `decryptBytes` with the
  workspace keyring and `aad = utf8(assetId)`, build a typed `Blob`, point the
  `<img>` or PDF viewer at a `blob:` URL. Revoke the object URL on unmount.
  Handle a decrypt failure on a 200 response (see Edge Cases).

### Phase 3: Local-only tier

- [ ] **3.1** Allow an asset to keep its `EncryptedBlob` in the local workspace
  store and never upload it; the document references it the same way; the client
  resolves it locally first. Promotion to Tier 1 uploads the unchanged bytes.

## Edge Cases

### `<img src>` cannot point at ciphertext

A plain `<img>` cannot fetch and decrypt. Every Epicenter client runs JS and
holds the workspace key, so the client fetches, decrypts, and uses
`URL.createObjectURL`. The asset renders inside the app, not in a raw browser
tab. This is the accepted cost and it is the same pattern encrypted document
content already uses.

### A successful fetch is not a successful render

`GET /api/assets/<assetId>` returns `200` plus ciphertext even when the blob is
corrupt, truncated, or encrypted under a key version no longer in the keyring.
`decryptBytes` then throws (Poly1305 tag mismatch, or "key version N is not in
the keyring"). The client needs an explicit decrypt-error render state; the
HTTP layer cannot surface it. This is the same failure mode as a document field
encrypted under a dropped key version.

### Key rotation

When `ENCRYPTION_SECRETS` rotates, `deriveSubjectKeyring` returns the new entry
plus the old ones. New assets encrypt under the newest version; the version byte
is written into blob byte 1. Old asset blobs keep their old version byte and
stay decryptable as long as their root secret remains in `ENCRYPTION_SECRETS`.
`decryptBytes` selects the key by that byte. Assets follow the document model
exactly: **no asset is ever re-encrypted on rotation**, and dropping an old root
secret orphans old assets and old documents identically.

### Format-version mismatch

Blob byte 0 is the format version (`1`). A future chunked format would be
version `2`; an old client fetching a v2 blob gets a clear
"Unknown encryption format version" error rather than garbage. The header
already carries the discriminator, which is why deferring chunked AEAD is safe.

### HTTP range requests on a single AEAD blob

A whole-blob AEAD ciphertext cannot be partially decrypted. v1 downloads the
whole ciphertext (bounded by the 25 MB asset cap) and decrypts it in memory;
peak transient client memory is roughly twice the asset size. The read route
does not expose `Range`. A chunked AEAD format would restore progressive decode
and range-ish access; see Open Questions.

### Operator-visible metadata

`ciphertextBytes` and `uploadedAt` remain visible to the deployment operator,
and ciphertext length approximates plaintext length. Hiding size needs padding,
which is out of scope. `contentType` and `originalName` are hidden because they
move into the encrypted document.

### A leaked URL after the model lands

A leaked `/api/assets/<assetId>` URL now yields ciphertext. The leak is no
longer a content breach, only a disclosure that an asset of some size exists.

### Losing the server-side MIME allow-list is safe here

The server can no longer sniff a ciphertext's type, so the `ALLOWED_MIME_TYPES`
allow-list moves client-side. The allow-list's security purpose was to stop a
user uploading executable HTML or SVG that the browser renders from the asset
origin (stored XSS). That vector is already closed: the read serves
`application/octet-stream` with `x-content-type-options: nosniff`, and the
client renders by constructing a `Blob` whose `type` *the client* chooses. The
client-side allow-list must therefore gate which `type` values the renderer will
build, not merely be a courtesy check on upload.

## Open Questions

All four are resolved.

1. **Whole-blob vs chunked AEAD.** **Resolved: whole-blob for v1.** Phase 0
   confirmed `@epicenter/encryption` has only a one-shot AEAD; chunked framing
   would be a new format (format-version byte `2`), real crypto-format work, and
   the header already supports the discriminator so it can be added later
   without breaking old blobs. Whole-blob is fine within the 25 MB cap; the cap
   is now also a client-memory parameter (peak ~2x the asset size). Revisit
   only on a measured complaint: large-PDF first-render latency, or memory
   pressure on a constrained client. Do not build chunked speculatively.

2. **Should the read endpoint stay unauthenticated.** **Resolved: keep it
   unauthenticated for v1**, on honest grounds (the draft's "embedding"
   rationale was wrong and is dropped). The reasoning: an `assetId` exists only
   inside an encrypted document, so any party that obtains it through the
   legitimate path already holds the workspace key and could decrypt the asset
   anyway. The only residual disclosure is to a party that captured the URL
   through a side channel (Referer, third-party log processor): they learn that
   a blob of ~plaintext size exists, and nothing else, since content, filename,
   and type are not in the URL or the response. That is the same size leak this
   spec already declares out of scope. Keeping the read auth-free also keeps it
   a pure stateless ciphertext proxy, identical for the R2 and filesystem
   backends. An authenticated read is the stricter choice and stays cheap to
   adopt later (`requireCookieOrBearerUser` already guards `/api/assets/*`;
   moving the GET into `assetAuthedRoutes` is the whole change). The invariant
   the decision rests on: **the `assetId` must never escape into a plaintext
   product channel** (a notification, an email body, an unencrypted index). If
   that invariant cannot hold, authenticate the read.

3. **A public asset tier.** **Resolved: refused for v1.** No in-app sharing
   exists to need it. If Epicenter ever ships public document sharing, a public
   asset is a plaintext blob in a separate, explicitly-labelled public store,
   and a separate spec.

4. **Metadata padding.** **Resolved: out of scope.** Blob size leaks; the leak
   is documented in the Threat Model and Edge Cases. Padding to size buckets
   would hide it; revisit only with a concrete threat that needs it.

## Decisions Log

- Encrypt assets with the embedding document's per-workspace key, not the raw
  subject key: Phase 0 confirmed this is the key the document's own YKeyValue
  stores use, so an asset becomes literally as private as its document and
  inherits its rotation behaviour. Revisit when: the workspace key derivation is
  reworked.
- Encrypt once at asset creation; never re-encrypt on upload or promotion: makes
  the local-only and synced tiers byte-identical. Revisit when: never, unless a
  per-destination key is introduced (it should not be).
- Generate the `assetId` client-side: it lets the client bind the ciphertext to
  the id with `aad` and reference the asset before the upload completes. Revisit
  when: a server-authoritative id becomes necessary for some other reason.
- Keep the asset read endpoint unauthenticated: once the body is ciphertext, an
  open endpoint serves only ciphertext plus size, and the `assetId` lives only
  inside encrypted documents. Revisit when: the `assetId` must appear in a
  plaintext channel, or hiding existence and size from a side-channel observer
  becomes a requirement.
- Remove HTTP range support from the encrypted read: a whole-blob AEAD
  ciphertext cannot be range-decrypted. Revisit when: a chunked AEAD format
  (format version 2) ships.
- Keep the unguessable `assetId` even though ciphertext already protects the
  content: it is near-free and stops enumeration of blobs and their sizes.
  Revisit when: never, unless the id scheme is reworked for another reason.

## Success Criteria

- [ ] An uploaded asset is stored as ciphertext; reading the blob store, the
  filesystem, or a DB backup without `ENCRYPTION_SECRETS` yields no image.
- [ ] The asset is encrypted under the embedding document's workspace key, with
  the same primitive (`encryptBytes`) and format the document's fields use.
- [ ] A leaked `/api/assets/<assetId>` URL discloses ciphertext and size only.
- [ ] The client renders an asset by fetching ciphertext and decrypting; no
  plaintext asset crosses the network.
- [ ] The `asset` server row holds no `contentType` and no `originalName`.
- [ ] The encrypted read serves `application/octet-stream`, keeps ETag / 304,
  and exposes no `Accept-Ranges`.
- [ ] An asset can be kept local-only and never uploaded; promotion to a synced
  asset copies the unchanged ciphertext.

## References

- `specs/20260522T220000-api-runtime-portability.md` - owns the `AssetStore`
  contract and the flat `/api/assets/<assetId>` URL this spec builds on.
- `specs/20260522T200000-cloud-workspace-ownership-model.md` - the subject model
  and the refusal of key wrapping, escrow, and in-app sharing.
- `docs/articles/20260522T210000-an-organization-is-a-deployment.md` - "can you
  see it means can you decrypt it"; the encryption framing this spec restores
  for assets.
- `apps/api/src/asset-routes.ts` - the current plaintext upload/read routes,
  including the `Range` handling Phase 1.3 removes.
- `apps/api/src/auth/encryption.ts` - `deriveSubjectKeyring`; the per-subject
  keyring delivered to the client, from which the workspace key is derived.
- `apps/api/src/app.ts` - mounts `assetPublicRoutes` (unauthenticated) and
  `assetAuthedRoutes`; returns the subject keyring on the auth-session response.
- `packages/encryption/src/blob.ts` - `EncryptedBlob`, `encryptBytes`,
  `decryptBytes` (the arbitrary-bytes AEAD primitive the asset path calls).
- `packages/encryption/src/derivation.ts` - `deriveWorkspaceKey`,
  `deriveSubjectKeyring`; the derivation chain (Phase 0 verified).
- `packages/workspace/src/document/attach-encryption.ts` - the document
  encryption coordinator; verified to have no arbitrary-bytes method, hence not
  the asset entry point. Its `deriveWorkspaceKeyring` use is the pattern the
  asset decrypt path mirrors.
