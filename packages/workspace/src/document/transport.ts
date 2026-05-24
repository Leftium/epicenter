import type { OwnerId } from '@epicenter/auth';

/**
 * Options for {@link roomWsUrl}: the full base URL of the API host, the
 * workspace `ownerId` (which selects the partitioned URL path), the room
 * `guid`, and the per-client `installationId` query value.
 */
export type RoomWsUrlOptions = {
	baseURL: string;
	ownerId: OwnerId;
	guid: string;
	installationId: string;
};

/**
 * Build the WebSocket URL for a hosted room.
 *
 * Single URL form: `wss://<baseURL>/api/owners/<ownerId>/rooms/<guid>?installationId=<id>`
 *
 * In personal mode `ownerId` equals the signed-in user's id; in team mode it
 * is the literal `'team'`. The URL shape is uniform across both modes.
 *
 * The `guid` is `encodeURIComponent`-encoded so ids containing `/`, `?`, or
 * `#` round-trip safely; the server's Hono routes decode the path param. The
 * `baseURL` trailing slash is stripped so callers can pass either
 * `https://api.example.com` or `https://api.example.com/`. The `http(s)`
 * origin is rewritten to `ws(s)`.
 */
export function roomWsUrl(options: RoomWsUrlOptions): string {
	const base = options.baseURL.replace(/\/+$/, '');
	const encodedGuid = encodeURIComponent(options.guid);
	const path = `/api/owners/${options.ownerId}/rooms/${encodedGuid}`;
	const search = `?installationId=${encodeURIComponent(options.installationId)}`;
	return `${base}${path}${search}`
		.replace(/^https:/, 'wss:')
		.replace(/^http:/, 'ws:');
}
