/**
 * Max incoming message/payload size (5 MB).
 *
 * This is an application-level guard, not a Cloudflare platform limit.
 * Workers allow 100 MB+ request bodies and DO WebSockets allow 32 MiB messages,
 * but we cap at 5 MB to keep memory usage reasonable (Workers have a 128 MB limit
 * and we buffer the full body with `arrayBuffer()`).
 */
export const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Max content-addressed blob size (5 GiB).
 *
 * Blob bytes never pass through the Worker: the upload is a presigned PUT
 * straight to R2, so the ~100 MB Worker request-body cap does not apply. The
 * ceiling here is R2's single-PUT limit (~5 GiB); larger
 * objects need multipart (deferred) or the receipt's `external` location.
 * See `specs/20260623T220000-content-addressed-blob-store.md`.
 */
export const MAX_BLOB_BYTES = 5 * 1024 * 1024 * 1024;
