import { BEARER_SUBPROTOCOL_PREFIX, parseSubprotocols } from '@epicenter/sync';
import { createMiddleware } from 'hono/factory';
import { parseBearer } from '../auth/parse-bearer.js';

/**
 * Normalize the auth transport on a WebSocket upgrade.
 *
 * ## Why this exists
 *
 * A browser `new WebSocket(url, protocols)` upgrade is the one request where
 * the client cannot control its own credentials:
 *
 * - It MUST attach the same-origin Better Auth session cookie. There is no
 *   `credentials: 'omit'` for the WebSocket API, so unlike every other
 *   transport in `@epicenter/auth` (all of which already omit it) an upgrade
 *   always carries the ambient cookie.
 * - It CANNOT set `Authorization`. The only channel for an OAuth bearer is
 *   the `Sec-WebSocket-Protocol` list, as `bearer.<token>` (see
 *   `@epicenter/sync` `auth-subprotocol.ts`).
 *
 * Rooms is the only WebSocket surface and it is bearer-only
 * ({@link requireBearerUser} never reads the cookie). So on an upgrade the
 * cookie is always ambient noise and the subprotocol bearer is always the
 * intended credential. This middleware makes that structural:
 *
 *   1. Drop the `Cookie`. A WebSocket upgrade is a bearer-only transport in
 *      this product, so the cookie can never authenticate it. Dropping it
 *      unconditionally turns "WS is bearer-only" from a per-route convention
 *      into an invariant a future handler cannot bypass.
 *   2. Lift a single `bearer.<token>` subprotocol entry into
 *      `Authorization: Bearer <token>` so bearer auth sees one canonical
 *      input, and strip it from the echoed subprotocol list. (The Durable
 *      Object also rebuilds a fresh response header set and echoes only the
 *      main `epicenter` subprotocol, so the token never round-trips either
 *      way; stripping here keeps it out of intermediate handlers too.)
 *
 * It never authenticates and never rejects. A missing, empty, or duplicate
 * bearer attaches nothing, and the downstream {@link requireBearerUser}
 * answers 401. Cookie-vs-bearer precedence on ordinary HTTP routes is not
 * this middleware's concern: `requireCookieOrBearerUser` (cookie-first) and
 * `requireBearerUser` (bearer-only) own that, deterministically. Better
 * Auth's `bearer()` plugin is not enabled, so `getSession` reads only the
 * cookie; the OAuth bearer is a separate JWT verified against JWKS. The two
 * credentials are read by disjoint code paths and never merge, so there is
 * no ambiguity to police at the edge.
 *
 * The in-place `c.req.raw` rewrite is Hono's supported header-mutation
 * pattern (used by `methodOverride` and `bodyLimit`): build a fresh
 * `Headers`, construct a new `Request`, reassign.
 *
 * Mount in front of the WebSocket route. Non-upgrade requests pass through
 * untouched.
 */
export const normalizeWebSocketAuth = createMiddleware(async (c, next) => {
	const headers = c.req.raw.headers;
	const isUpgrade = headers.get('upgrade')?.toLowerCase() === 'websocket';
	if (!isUpgrade) return next();

	const normalized = new Headers(headers);
	normalized.delete('cookie');

	const wsBearer = parseWsBearer(headers.get('sec-websocket-protocol'));
	if (wsBearer) {
		// A non-browser WS client can set Authorization directly; prefer it and
		// treat the subprotocol bearer as already consumed.
		if (!parseBearer(headers.get('authorization'))) {
			normalized.set('authorization', `Bearer ${wsBearer.token}`);
		}
		if (wsBearer.remaining.length > 0) {
			normalized.set('sec-websocket-protocol', wsBearer.remaining.join(', '));
		} else {
			normalized.delete('sec-websocket-protocol');
		}
	}

	c.req.raw = new Request(c.req.raw, { headers: normalized });
	await next();
});

/**
 * Extract a single `bearer.<token>` entry from a `Sec-WebSocket-Protocol`
 * header, returning the token and the non-bearer subprotocols to echo back.
 *
 * Returns null when there is no usable bearer: none present, an empty
 * `bearer.` token, or more than one (a malformed client). The caller attaches
 * nothing in that case and lets bearer auth answer 401.
 */
function parseWsBearer(
	value: string | null,
): { token: string; remaining: string[] } | null {
	const bearers: string[] = [];
	const remaining: string[] = [];
	for (const protocol of parseSubprotocols(value)) {
		if (protocol === '') continue;
		if (protocol.startsWith(BEARER_SUBPROTOCOL_PREFIX)) {
			bearers.push(protocol.slice(BEARER_SUBPROTOCOL_PREFIX.length));
		} else {
			remaining.push(protocol);
		}
	}
	if (bearers.length !== 1) return null;
	const token = bearers[0];
	if (!token) return null;
	return { token, remaining };
}
