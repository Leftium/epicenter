import type { Context } from 'hono';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';
import type { OAuthError } from './oauth-error.js';

type CreateWebSocketPair = () => InstanceType<typeof WebSocketPair>;

/**
 * Map an {@link OAuthError} to the protected-resource auth failure response
 * for HTTP and WebSocket-upgrade requests on the same route.
 *
 * Status mapping (RFC 6750):
 * - `InvalidToken`: HTTP 401 with `WWW-Authenticate: Bearer error="invalid_token"`;
 *   WS close 4401.
 * - `InsufficientScope`: HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope" scope="<scope>"`;
 *   WS close 4403.
 *
 * The serialized error object (`{ name, message, ...fields }`) is itself the
 * JSON body and the WS close-reason payload; clients reconstruct by branching
 * on `error.name`.
 */
export function createOAuthUnauthorizedResourceResponse(
	c: Context,
	error: OAuthError,
	createWebSocketPair: CreateWebSocketPair = () => new WebSocketPair(),
) {
	const isUpgrade = isWebSocketUpgrade(c);

	if (error.name === 'InsufficientScope') {
		if (!isUpgrade) {
			c.header(
				'WWW-Authenticate',
				`Bearer error="insufficient_scope" scope="${error.scope}"`,
			);
			return c.json(error, 403);
		}
		return closeUpgrade(createWebSocketPair, 4403, error);
	}

	// InvalidToken: missing, malformed, unverifiable, or user-not-found.
	if (!isUpgrade) {
		c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
		return c.json(error, 401);
	}
	return closeUpgrade(createWebSocketPair, 4401, error);
}

function closeUpgrade(
	createWebSocketPair: CreateWebSocketPair,
	code: 4401 | 4403,
	error: OAuthError,
) {
	const pair = createWebSocketPair();
	const [client, server] = [pair[0], pair[1]];
	server.accept();
	server.close(code, JSON.stringify(error));
	return new Response(null, { status: 101, webSocket: client });
}
