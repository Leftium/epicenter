/**
 * Transport helpers shared by document sync primitives.
 *
 * Lives outside the sync supervisor because URL massaging is a pre-supervisor
 * concern: callers decide which endpoint a doc connects to long before the
 * supervisor opens a socket.
 */

/** Coerce an HTTP(S) origin into the matching WS(S) origin. Bare strings only. */
export function toWsUrl(httpUrl: string): string {
	return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}
