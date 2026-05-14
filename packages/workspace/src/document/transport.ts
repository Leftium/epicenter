/** Convert an HTTP(S) URL string to the matching WS(S) URL string. */
export function websocketUrl(url: string): string {
	return url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}
