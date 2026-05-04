import { BEARER_SUBPROTOCOL_PREFIX, parseSubprotocols } from '@epicenter/sync';
import type { BetterAuthOptions } from 'better-auth';
import { getSessionCookie } from 'better-auth/cookies';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { createAuth } from './create-auth';

/**
 * Reject requests that carry more than one authentication credential and lift
 * any WebSocket subprotocol bearer into `Authorization` so downstream code
 * (Better Auth's `getSession`) sees one canonical input.
 *
 * ## Why this exists
 *
 * Better Auth's bearer plugin silently resolves the cookie-vs-bearer ambiguity
 * in undocumented, historically buggy ways. Verified upstream against
 * `packages/better-auth/src/plugins/bearer/index.ts`:
 *
 * - A valid `Authorization: Bearer` overwrites the session cookie internally.
 * - An invalid bearer is silently dropped, so a stale cookie can take over
 *   (`bearer.test.ts` literally tests this fallback).
 * - The 2026 changeset `fix-bearer-cookie-parse-mutate-serialize.md` fixed a
 *   bug where the merged `Cookie` header carried two `session_token` entries
 *   and downstream readers picked the stale one.
 *
 * Allowing clients to send both credentials is therefore a footgun. This
 * middleware removes the implicit decision: every request must carry at most
 * one credential; ambiguous requests are rejected at the edge before any
 * session lookup happens.
 *
 * ## What it does
 *
 * 1. Checks for the Better Auth session cookie via `getSessionCookie` from
 *    `better-auth/cookies`, threading `cookiePrefix` and the
 *    `cookies.session_token.name` override straight from `c.var.auth.options`
 *    so any future auth config change propagates with zero edits here.
 *    `getSessionCookie` itself handles the `__Secure-` prefix and the legacy
 *    dash-form fallback internally.
 * 2. Parses HTTP `Authorization: Bearer <token>` and the WebSocket bearer
 *    subprotocol `sec-websocket-protocol: epicenter, bearer.<token>`. Browsers
 *    cannot set `Authorization` on `new WebSocket(url)` upgrades, so the
 *    subprotocol is the only smuggling channel for WS auth.
 * 3. If a cookie and a bearer are both present, or two bearers disagree, throws
 *    HTTP 400. Otherwise, if only a WS bearer is present, mutates `c.req.raw`
 *    so downstream handlers see `Authorization: Bearer` directly. This is the
 *    same in-place rewrite pattern Hono's own `bodyLimit` middleware uses
 *    (`hono/src/middleware/body-limit/index.ts`).
 *
 * Mount globally so the well-formedness check runs on every route, after the
 * middleware that sets `c.var.auth`.
 */
export const singleCredential = createMiddleware<{
	Variables: { auth: ReturnType<typeof createAuth> };
}>(async (c, next) => {
	const headers = c.req.raw.headers;
	// Cast widens the `satisfies`-narrowed type from create-auth.ts so we can
	// read `cookies.session_token.name` even though our config doesn't set it.
	const advanced = (c.var.auth.options as BetterAuthOptions).advanced;
	const cookie = getSessionCookie(c.req.raw, {
		cookiePrefix: advanced?.cookiePrefix,
		cookieName: advanced?.cookies?.session_token?.name,
	});
	const httpBearer = parseHttpBearer(headers.get('authorization'));
	const wsBearer = parseWsBearer(headers.get('sec-websocket-protocol'));

	if (cookie && (httpBearer || wsBearer)) {
		throw new HTTPException(400, { message: 'multiple_credentials' });
	}
	if (httpBearer && wsBearer && httpBearer !== wsBearer) {
		throw new HTTPException(400, { message: 'multiple_credentials' });
	}

	if (wsBearer && !httpBearer) {
		const normalized = new Headers(headers);
		normalized.set('authorization', `Bearer ${wsBearer}`);
		c.req.raw = new Request(c.req.raw, { headers: normalized });
	}

	await next();
});

function parseHttpBearer(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}

function parseWsBearer(value: string | null): string | null {
	const entry = parseSubprotocols(value).find((protocol) =>
		protocol.startsWith(BEARER_SUBPROTOCOL_PREFIX),
	);
	return entry ? entry.slice(BEARER_SUBPROTOCOL_PREFIX.length) : null;
}
