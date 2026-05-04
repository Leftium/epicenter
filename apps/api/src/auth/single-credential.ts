import { BEARER_SUBPROTOCOL_PREFIX, parseSubprotocols } from '@epicenter/sync';

export type SingleCredentialResult =
	| { status: 'ok'; kind: 'cookie' | 'bearer'; headers: Headers }
	| { status: 'none'; headers: Headers }
	| { status: 'mixed' };

const SESSION_COOKIE_NAMES = new Set([
	'better-auth.session_token',
	'better-auth-session_token',
]);
const SECURE_COOKIE_PREFIX = '__Secure-';
const HOST_COOKIE_PREFIX = '__Host-';

export function singleCredential(headers: Headers): SingleCredentialResult {
	const normalizedHeaders = new Headers(headers);
	const cookie = hasSessionCookie(normalizedHeaders);
	const bearer = getBearerCredential(normalizedHeaders);

	if (cookie && bearer !== null) return { status: 'mixed' };
	if (bearer?.status === 'conflict') return { status: 'mixed' };
	if (bearer?.status === 'ok') {
		normalizedHeaders.set('authorization', `Bearer ${bearer.token}`);
		return { status: 'ok', kind: 'bearer', headers: normalizedHeaders };
	}
	if (cookie)
		return { status: 'ok', kind: 'cookie', headers: normalizedHeaders };
	return { status: 'none', headers: normalizedHeaders };
}

function getBearerCredential(
	headers: Headers,
): { status: 'ok'; token: string } | { status: 'conflict' } | null {
	const tokens = [
		getAuthorizationBearer(headers),
		getWebSocketBearer(headers),
	].filter((token) => token !== null);

	if (tokens.length === 0) return null;
	if (new Set(tokens).size > 1) return { status: 'conflict' };
	const [token] = tokens;
	if (token === undefined) return null;
	return { status: 'ok', token };
}

function getAuthorizationBearer(headers: Headers): string | null {
	const authorization = headers.get('authorization')?.trim();
	if (!authorization) return null;
	const match = authorization.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || null;
}

function getWebSocketBearer(headers: Headers): string | null {
	const bearer = parseSubprotocols(headers.get('sec-websocket-protocol')).find(
		(protocol) => protocol.startsWith(BEARER_SUBPROTOCOL_PREFIX),
	);
	return bearer?.slice(BEARER_SUBPROTOCOL_PREFIX.length) || null;
}

function hasSessionCookie(headers: Headers): boolean {
	const cookie = headers.get('cookie');
	if (!cookie) return false;
	return cookie.split(';').some((entry) => {
		const [rawName] = entry.trim().split('=', 1);
		if (rawName === undefined) return false;
		return SESSION_COOKIE_NAMES.has(stripCookiePrefix(rawName));
	});
}

function stripCookiePrefix(cookieName: string): string {
	if (cookieName.startsWith(SECURE_COOKIE_PREFIX)) {
		return cookieName.slice(SECURE_COOKIE_PREFIX.length);
	}
	if (cookieName.startsWith(HOST_COOKIE_PREFIX)) {
		return cookieName.slice(HOST_COOKIE_PREFIX.length);
	}
	return cookieName;
}
