/**
 * Server-only derived identifiers built from an `OwnerId`.
 *
 * `OwnerId` itself lives in `@epicenter/identity` because it flows through
 * `/api/session`, the persisted auth cell, and every client (browser,
 * extension, CLI, daemon). What lives here are the durable strings only
 * a server cares about: Durable Object names, R2 object keys, and the
 * partition path segment they all share.
 *
 * Personal mode and shared mode share the exact same path shape. The
 * partition segment is always `owners/<ownerId>`. In personal mode
 * `ownerId` is the signed-in user's id; in shared mode it is the literal
 * string `'shared'`. The path is honest in both modes: every durable
 * identifier the server writes is rooted at `owners/<ownerId>`.
 *
 * Every durable string follows the rule:
 *   `owners/<ownerId>/<resource type>/<id>`
 *
 * One shape, one helper per resource type, no ternary.
 */

import type { OwnerId } from '@epicenter/identity';

/** Durable Object name template, single form. */
export type RoomDoName = `owners/${string}/rooms/${string}`;

/** R2 object key template, single form. */
export type AssetR2Key = `owners/${string}/assets/${string}`;

/**
 * R2 object key template for a content-addressed blob, single form. The id
 * segment is a sha256 hex digest, so the key IS the content address: R2 is
 * the index, with no separate database row. See
 * `specs/20260623T220000-content-addressed-blob-store.md`.
 */
export type BlobR2Key = `owners/${string}/blobs/${string}`;

/** Common prefix for one owner's blobs, used by the S3 client's list enumeration. */
export type BlobOwnerPrefix = `owners/${string}/blobs/`;

/** Durable name of a room's Cloudflare Durable Object. */
export function doName(ownerId: OwnerId, roomId: string): RoomDoName {
	return `owners/${ownerId}/rooms/${roomId}`;
}

/** Durable key of an asset's R2 object. */
export function assetKey(ownerId: OwnerId, assetId: string): AssetR2Key {
	return `owners/${ownerId}/assets/${assetId}`;
}

/** Durable key of a content-addressed blob's R2 object (id = sha256 hex). */
export function blobKey(ownerId: OwnerId, sha256: string): BlobR2Key {
	return `owners/${ownerId}/blobs/${sha256}`;
}

/** Prefix matching every blob this owner has stored. */
export function blobOwnerPrefix(ownerId: OwnerId): BlobOwnerPrefix {
	return `owners/${ownerId}/blobs/`;
}
