import type { Owner } from '@epicenter/auth';

/**
 * Options for {@link roomWsUrl}: the full base URL of the API host, the
 * workspace `owner` (which selects the personal vs team URL shape), the room
 * `guid`, and the per-client `clientId` query value.
 */
export type RoomWsUrlOptions = {
	baseURL: string;
	owner: Owner;
	guid: string;
	clientId: string;
};

/**
 * Build the WebSocket URL for a hosted room.
 *
 * Personal: `wss://<baseURL>/api/users/<owner.userId>/rooms/<guid>?clientId=<id>`
 * Team:     `wss://<baseURL>/api/rooms/<guid>?clientId=<id>`
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
	const path =
		options.owner.kind === 'personal'
			? `/api/users/${options.owner.userId}/rooms/${encodedGuid}`
			: `/api/rooms/${encodedGuid}`;
	const search = `?clientId=${encodeURIComponent(options.clientId)}`;
	return `${base}${path}${search}`
		.replace(/^https:/, 'wss:')
		.replace(/^http:/, 'ws:');
}
