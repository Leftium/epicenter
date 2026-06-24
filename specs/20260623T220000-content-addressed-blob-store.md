# Content-Addressed Blob Store (the kernel)

- **Status:** Draft
- **Date:** 2026-06-23
- **Branch:** wash-saddle
- **Supersedes:** the `asset` route/table/bucket (`packages/server/src/routes/assets.ts`, `db/schema/app.ts` `asset`, binding `ASSETS_BUCKET`)

## One sentence

```
Vault  = the map     (a receipt in markdown frontmatter: sha256, source, S3 key)
Store  = the bytes    (content-addressed, owner-prefixed, S3 LIST is the only index)
Server = a doorway    (mints presigned PUT/GET, gates reads — no database, no queue, no events)
```

A content-addressed blob store with **no blob database**: an S3-compatible store holds the bytes and *is* the index; the vault receipt holds the rich metadata; a thin server mints presigned URLs and gates reads using one S3 credential and a per-owner key prefix. The store is reached as a **portable S3 client** (aws4fetch, no Workers R2 binding), so the identical code runs on the hosted Cloudflare Worker against R2 and in a self-hosted Node binary against MinIO/Garage/S3.

## How we got here

The first draft mirrored R2 into a Postgres `blob` table kept in sync by R2 event-notifications → a Queue. That mirror was the smell: a content-addressed store is already a key-value index of exactly its blobs, so the table — and all the queue/event/confirm/reconcile plumbing the table required — was redundant. Removing it deletes ~⅔ of the surface. What the table's one real job (quota sum) needed was Autumn, which was always going to hold that number. So: no table, no queue, no events.

A second pass re-grilled presigned-S3 vs the native Workers R2 binding from a greenfield stance, and the verdict hardened *toward* presigned for two independent reasons. **Integrity:** R2 enforces a whole-object `x-amz-checksum-sha256` only on a single `PutObject`; multipart can only do a `COMPOSITE` (hash-of-part-hashes) checksum, never `FULL_OBJECT` (grounded on `cloudflare/cloudflare-docs`). The native binding cannot single-PUT past the edge request-body cap (100 MB Pro / 200 Business / 500 Ent, enforced even when streaming), so for the target workload (video archive, files routinely >100 MB) it is forced into multipart — which *cannot* verify the content address, breaking the store's whole premise, or needs a stateful Durable Object to hash incrementally (re-adding the deleted plumbing). A single presigned PUT (≤5 GiB, covering the use case) keeps R2-enforced whole-object sha256 with zero server state. **Portability:** the `R2Bucket` binding is a Workers-only API; presigned SigV4 is an open standard that works against any S3 endpoint. So the binding is the *lock-in* choice and presigned is the portable one. We therefore drop the binding entirely and talk pure S3 (presign PUT/GET; sign head/list/delete) so the module is deployment-portable. aws4fetch is the right signer: tiny single-file SigV4, **officially documented by Cloudflare for R2**, ~4.3M weekly npm downloads, last released 2024 — "complete against a frozen standard," not abandoned.

## Locked decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Identity | content-addressed, key = `sha256` hex | dedup + intrinsic integrity + idempotent upload |
| 2 | Tenancy | owner-prefixed `owners/<ownerId>/blobs/<sha256>` | *content-address within a trust boundary, never across one*; dedup stays where it's safe, GC + isolation owner-local |
| 3 | Owner | the existing `OwnerId` seam (`user.id` / `'shared'`) | blobs inherit multi-tenancy free; nothing new to model |
| 4 | Upload | one upload-ticket = presigned R2 PUT (cloud) / local endpoint (desktop) | Worker request-body cap (~100 MB, edge-enforced) is bypassed; one mechanism, one SDK method, no size-branch |
| 5 | Integrity | S3 enforces `x-amz-checksum-sha256` on single PutObject | server-authoritative, no in-server hashing; mismatch → `400 BadDigest`. **The object appearing under its hash IS the record** — no confirm step. Multipart can't do this (COMPOSITE only), which is *why* single-PUT (≤5 GiB) is the ceiling |
| 6 | **Index** | **S3 ListObjectsV2 + on-object metadata. No Postgres `blob` table.** | the content-addressed store is its own index; listing = signed `?list-type=2&prefix=…`, rich metadata = the vault receipt |
| 7 | **No queue / no events** | removed | nothing needs a synchronous upload signal: content-addressing + checksum-at-PUT already guarantee integrity; orphans swept by an occasional LIST |
| 8 | Reads | private → server auth → 302 short-TTL presigned GET | free egress, auth-gated, server off the byte path |
| 9 | Visibility | **v1 = all private (one bucket).** Public = a **second public bucket** on a custom domain, deferred | grounded: R2 public access is **bucket-level, not prefix-level** — a `public/` prefix does not work |
| 10 | Quota | **v1 = none (don't call Autumn).** Billed era = Autumn `continuous_use storage_bytes` on an `autoEnable` default plan | grounded: Autumn `check()` **denies by default** when no plan is attached, so "deferred" = *don't call it*, not "call and hope" |
| 11 | Name | `blobs` (SDK `client.blobs`, CLI `epicenter blobs add`, bucket `epicenter-blobs`) | neutral substrate; domain features (`whispering.recordings`) wrap it |
| 12 | **Transport** | **pure S3 client (aws4fetch), NO Workers R2 binding** | one mechanism for presign + head/list/delete; runs identically on the Worker (R2) and a Node binary (MinIO/Garage/S3) — the binding would be Workers-only lock-in. Endpoint is config (`BLOBS_S3_ENDPOINT`), not code |

## The API

A `blobs` Hono sub-router mounted on the existing app (`apps/api/worker/index.ts`, beside `mountAssetsApp`). All routes auth + ownership gated; bearer-JWT path (CLI) is the primary consumer.

### `POST /owners/:ownerId/blobs` — request an upload ticket

Request `{ sha256, sizeBytes, contentType }`. The server:
1. verifies the bearer JWT (signature only, `payload.sub` → owner) and that `:ownerId` matches,
2. *(billed era only)* `autumn.check({ featureId: 'storage_bytes', requiredBalance: sizeBytes })`,
3. `store.head(blobKey)` — a signed S3 HeadObject; if the object already exists → `200 { status: 'duplicate', url }` (no upload),
4. else mints a presigned PUT via `aws4fetch` (`signQuery`), signing `Content-Type` and `x-amz-checksum-sha256`, `X-Amz-Expires≈300` → `200 { status: 'upload', uploadUrl, requiredHeaders, expiresInSeconds }`.

### *(client → store directly, not an Epicenter endpoint)*

Client PUTs bytes to `uploadUrl`, sending `x-amz-checksum-sha256` (**base64** of the same digest the **hex** key uses) + `Content-Type`. The store validates the checksum; mismatch → `400 BadDigest`. Bytes never touch the server. On success the **CLI writes the receipt** (it saw the 200) — no server round-trip.

### `GET /owners/:ownerId/blobs/:sha256` — read

Auth + ownership → 302 to a short-TTL presigned GET (direct to the store, not edge-cached). v1: all private.

### `GET /owners/:ownerId/blobs` — list / usage

`store.list('owners/<owner>/blobs/')` — a signed `ListObjectsV2` paginating on `IsTruncated`+`NextContinuationToken` (max 1000/page), XML parsed for `Key`/`Size`/`LastModified`. Returns `[{ sha256, size, uploaded }]`; `usage` = Σ`size`. Cache the sum if it ever gets hot (>~10k objects).

### `DELETE /owners/:ownerId/blobs/:sha256`

Auth + ownership → `store.delete(key)` (signed S3 DeleteObject). Owner-local, idempotent — no cross-tenant refcount because nothing is shared across owners.

**No `confirm` endpoint, no queue consumer, no reconcile job.** (Grounded gap: there's no synchronous upload-completion hook without a queue — accepted, because content-addressing + checksum-at-PUT *is* the integrity guarantee, and an occasional LIST sweep catches abandoned uploads.)

### SDK (`@epicenter/client`)

```ts
client.blobs = {
  add(fileOrUrl, { contentType }?): Promise<{ sha256, url, duplicate }>,  // hash → ticket → PUT
  url(ownerId, sha256): string,                                            // sync, content-addressed
  get(sha256): Promise<Response>,                                          // follows the 302
  list(): Promise<{ sha256, size, uploaded }[]>,
  usage(): Promise<{ totalBytes: number }>,
  delete(sha256): Promise<void>,
}
```
Hand-rolled `fetch` over `AuthFetch` (the GET is a redirect-follow and the ticket flow is multi-step — Hono `hc` types those awkwardly).

### CLI

`epicenter blobs add <url|file>` (yargs, beside `auth`/`run`): resolve bytes → hash → ticket → PUT → write the receipt frontmatter + a local working copy. Constructs the client from `createMachineAuthClient()`; **does not** route through the local daemon (it's a cloud round-trip).

## Auth — DB-free presign path

The bearer/JWT path verifies the token by JWKS signature with **no DB call** (Better Auth `jwt` plugin, EdDSA, `createRemoteJWKSet` caches in-process; `payload.sub` = userId). The current `resolveRequestOAuthUser` (`require-auth.ts:99-101`) adds a Postgres `user.findFirst` existence check — for a fully DB-free presign path, **trust `sub` and skip that lookup**. Tradeoff (grounded): an offline-verified JWT can't be revoked before expiry, so keep access-token TTL short (Better Auth default 15 min); revoke at the refresh-token layer. This is an optional toggle — the cheap indexed lookup is fine to keep; the point is there is **no blob table** either way.

## The vault receipt

Grounded correction: matter is **filesystem + SQLite mirror, not Yjs**. The receipt is markdown **frontmatter** in the note (matter's source of truth; no sidecar convention) and rides the existing file-watch → SQLite sync:

```yaml
sha256: <hex>
source_url: https://www.youtube.com/watch?v=...
size_bytes: 4475420
content_type: video/mp4
location:
  provider: epicenter            # epicenter | external
  owner: <ownerId>
  key: owners/<ownerId>/blobs/<sha256>
encryption: none                 # none | convergent | per-file  (reserved)
archived_at: 2026-06-24T17:00:00-07:00
```

The note **body** references a local working-copy relative path (offline, plain markdown); publish/render resolves it to the durable URL. `provider: external` is the escape hatch for >5 GB or self-hosted-elsewhere bytes (tracked, not hosted).

## Infra to provision

- R2 bucket `epicenter-blobs` (private). **No `r2_buckets` binding** — the store is a pure S3 client.
- Worker secrets (set via `wrangler secret put`): `BLOBS_S3_ENDPOINT` (`https://<accountId>.r2.cloudflarestorage.com`), `BLOBS_S3_ACCESS_KEY_ID`, `BLOBS_S3_SECRET_ACCESS_KEY` (a **bucket-scoped** Object Read & Write token — none exist today). Optional vars `BLOBS_S3_BUCKET` (default `epicenter-blobs`) and `BLOBS_S3_REGION` (default `auto`). *Optional defense-in-depth (grounded): mint per-owner-**prefix**-scoped R2 temporary credentials instead of the bucket-wide token.*
- Bucket CORS (browser uploads/reads only; the CLI needs none): `AllowedMethods:["PUT","GET"]`, `AllowedHeaders:["content-type","x-amz-checksum-sha256"]`, `ExposeHeaders:["ETag"]`, `AllowedOrigins:[app origins]`.

## Deployment variants

| Deployment | Ticket = | Index | Endpoint + credential |
|---|---|---|---|
| Hosted cloud (`apps/api`) | presigned S3 PUT | signed S3 LIST | `BLOBS_S3_ENDPOINT` = R2; Worker holds the token |
| Self-host binary / BYO | presigned S3 PUT | signed S3 LIST | `BLOBS_S3_ENDPOINT` = MinIO/Garage/S3; binary holds the token |
| Desktop / local | local endpoint → disk | local FS / SQLite | none (local) |

**Same code, same S3 protocol throughout** — only the endpoint string and who-holds-the-credential differ. The cloud and self-host rows run the *identical* `s3-blob-store.ts` (aws4fetch on `fetch`+`SubtleCrypto`, present on Workers and Node).

## Grounding (corrections that changed the spec)

- **Presigned-S3 vs native R2 binding** (`cloudflare/cloudflare-docs` + aws4fetch source): the binding cannot single-PUT past the **edge request-body cap** (100 MB Pro / 200 Business / 500 Ent, enforced even when streaming), forcing multipart for the target workload; **multipart cannot verify a whole-object sha256** (`SHA256` is `COMPOSITE` only, never `FULL_OBJECT`; ETag is `md5-of-part-md5s-N`), so it breaks content addressing — only **single PutObject** enforces `x-amz-checksum-sha256` (→ `400 BadDigest`, since ~June 2023). The binding is also a **Workers-only API** (lock-in). aws4fetch verified against source: `service:'s3' && signQuery` ⇒ canonical payload `UNSIGNED-PAYLOAD` (no header emitted) + single-encoded S3 path; Cloudflare officially documents it for R2; ~4.3M weekly downloads, last release 2024 (SigV4 is frozen). **No Cloudflare-native "direct creator upload" exists for R2** (only Images/Stream) — presigned S3 *is* the direct-to-store primitive.
- **Cloudflare R2** (`cloudflare/cloudflare-docs`): LIST (`ListObjectsV2`) returns `Size`+`LastModified` per `Contents`, paginate on `IsTruncated`+`NextContinuationToken`, max 1000; egress free, Worker→R2 in-network free; R2 tokens are bucket/account-scoped (prefix isolation is app-enforced; optional prefix-scoped *temp* creds exist); **public access is bucket-level → public/private needs two buckets, not prefixes**; 302→presigned-GET confirmed; **no queue/events required** for this model.
- **Better Auth** (`better-auth/better-auth`): JWT verify is JWKS-signature-only, DB-free, `sub`=userId; cookie/`getSession` is DB-by-default (don't use it on this path); 15-min access-token TTL; offline JWT can't be revoked early.
- **Autumn** (`useautumn/autumn`): `check()` **denies when no plan is attached** → v1 must not call it (or use an `autoEnable` default plan carrying `storage_bytes`); `balances.update({ usage })` overwrites absolute — drive it from an R2 LIST-sum, not `track()` deltas (self-correcting with no DB backstop); `failOpen:false` for a hard quota.
- **Codebase**: no `apps/epicenter` dir; `ASSETS_BUCKET.list()` never called today (clean to adopt); private-asset read-gate (`assertPrivateAssetOwner`, `assets.ts:62-88`) is the pattern to mirror; receipt → matter frontmatter; **no R2 S3 credentials exist yet** (must provision).

## Non-goals / open questions

- **Public serving** (second bucket + custom domain) deferred until sharing is needed.
- **Client-side encryption** out of scope; receipt reserves `encryption` for a later convergent/per-file flip without a rewrite.
- **Multipart >5 GiB** deferred (receipt `external` covers it); single presigned PUT is ≤5 GiB. *Doubly justified:* multipart can't enforce the whole-object content hash anyway, so >5 GiB is a genuinely different integrity regime, not just a bigger upload.
- **Quota** unmetered in v1; Autumn (with `autoEnable` default plan) when storage is billed.
- **Live smoke test (still pending a real bucket)**: a presigned PUT signing `x-amz-checksum-sha256` + `content-type` actually accepted by R2 end-to-end; the live Autumn `balances.update` REST path. The aws4fetch *signing* is verified against source; only the round-trip against a live R2 bucket is unrun.
- **Self-host room backend** (`room/backends/bun` or `/node`): the Yjs WebSocket relay's portability to a binary is a *separate* project, but the `Rooms`/`RoomUpdateLog`/`RoomSocket` contracts already exist for it (`room/contracts.ts`). This blob store's pure-S3 design is the same no-lock-in posture applied to bytes.

## Implementation slices

1. ✅ Provision config: `BLOBS_S3_*` secrets in `wrangler.jsonc`, generated types. (Bucket + token + CORS provisioned by operator.)
2. ✅ `s3-blob-store.ts` portable S3 client (presign PUT/GET, signed head/list/delete) + `POST /owners/:ownerId/blobs` ticket endpoint.
3. ✅ `GET` (302 presigned), `GET` list/usage, `DELETE`.
4. SDK `client.blobs`.
5. CLI `epicenter blobs add` + receipt writer.
6. Retire `assets`: port opensidian/vocab/tab-manager, delete the route/table/bucket.
7. *(Deferred)* public second bucket; Autumn metering; desktop/local ticket; multipart; encryption.
