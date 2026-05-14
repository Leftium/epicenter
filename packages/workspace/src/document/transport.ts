/** Convert an HTTP(S) URL string to the matching WS(S) URL string. */
export function websocketUrl(url: string): string {
	return url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

/**
 * Build the HTTP(S) URL for a hosted room.
 *
 * Strips trailing slashes from `apiUrl` so callers can pass either
 * `https://api.example.com` or `https://api.example.com/` without
 * producing `//rooms/...`. `roomId` is `encodeURIComponent`-encoded so
 * ids containing `/`, `?`, or `#` round-trip safely; Hono decodes the
 * `:room` path param at the server.
 */
export function roomUrl(apiUrl: string, roomId: string): string {
	const base = apiUrl.replace(/\/+$/, '');
	return `${base}/rooms/${encodeURIComponent(roomId)}`;
}

/** Build the WebSocket URL for a hosted room. */
export function roomWsUrl(apiUrl: string, roomId: string): string {
	return websocketUrl(roomUrl(apiUrl, roomId));
}
