/**
 * Server-only derived identifiers built from an `Owner`.
 *
 * `Owner` itself lives in `@epicenter/auth` because it flows through
 * `/api/session`, the persisted auth cell, and every client (browser,
 * extension, CLI, daemon). What lives here are the durable strings only
 * a server cares about: Durable Object names, R2 object keys, and the
 * partition path segment they all share.
 *
 * Personal mode and team mode are the same product. Personal mode
 * partitions data by user. Team mode does not partition at all.
 *
 * The partition is one path segment, `users/<userId>`, that prefixes
 * every durable identifier the personal product writes. Team mode does
 * not write that segment because it has nothing to partition. There is
 * no `team/` literal anywhere except in the `Owner` discriminator.
 *
 * Every durable string follows the rule:
 *   `<partition>/<resource type>/<id>`
 * where `<partition>` is omitted when there is no partition.
 *
 * Note: clients that need a stable owner key call `ownerId(owner)` from
 * `@epicenter/auth`. It returns the same string as `ownerPath(owner)`
 * here (`users/<userId>` for personal, `''` for team). They are not
 * unified into one helper because they belong to different consumers,
 * but they agree on the value by construction.
 */

import type { Owner } from '@epicenter/auth';

/**
 * The partition segment that prefixes durable identifiers.
 * Personal owners contribute `users/<userId>`; team owners contribute
 * an empty string so `joinPath` drops the leading segment.
 */
export type OwnerPath = `users/${string}` | '';

/** Durable identifier types, narrowed for IDE clarity. */
export type RoomDoName = `users/${string}/rooms/${string}` | `rooms/${string}`;
export type AssetR2Key =
	| `users/${string}/assets/${string}`
	| `assets/${string}`;

/** Compute the partition segment for this Owner. */
export function ownerPath(o: Owner): OwnerPath {
	return o.kind === 'personal' ? `users/${o.userId}` : '';
}

/** Durable name of a room's Cloudflare Durable Object. */
export function doName(o: Owner, roomId: string): RoomDoName {
	return o.kind === 'personal'
		? `users/${o.userId}/rooms/${roomId}`
		: `rooms/${roomId}`;
}

/** Durable key of an asset's R2 object. */
export function assetKey(o: Owner, assetId: string): AssetR2Key {
	return o.kind === 'personal'
		? `users/${o.userId}/assets/${assetId}`
		: `assets/${assetId}`;
}
