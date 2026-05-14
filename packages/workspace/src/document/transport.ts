/** Convert an HTTP(S) URL string to the matching WS(S) URL string. */
export function websocketUrl(url: string): string {
	return url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

/** Build a WebSocket URL for a hosted sync room. */
export function syncRoomUrl(apiUrl: string, roomId: string): string {
	return websocketUrl(`${apiUrl}/sync/${encodeURIComponent(roomId)}`);
}
