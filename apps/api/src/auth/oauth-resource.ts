import { AiChatError } from '@epicenter/constants/ai-chat-errors';
import type { Context } from 'hono';

type CreateWebSocketPair = () => InstanceType<typeof WebSocketPair>;

export type OAuthResourceFailure =
	| { type: 'invalid_token' }
	| { type: 'insufficient_scope'; scope: string };

/**
 * Produce the protected-resource auth failure response for HTTP and
 * WebSocket-upgrade requests on the same route.
 *
 * - `invalid_token` (default): HTTP 401, WS close 4401 `invalid_token`.
 * - `insufficient_scope`: HTTP 403 with `WWW-Authenticate: Bearer
 *   error="insufficient_scope" scope="<scope>"`, WS close 4403 carrying
 *   the same code and scope.
 */
export function createOAuthUnauthorizedResourceResponse(
	c: Context,
	{
		createWebSocketPair = () => new WebSocketPair(),
		failure = { type: 'invalid_token' } as OAuthResourceFailure,
	}: {
		createWebSocketPair?: CreateWebSocketPair;
		failure?: OAuthResourceFailure;
	} = {},
) {
	const isUpgrade = c.req.header('upgrade') === 'websocket';

	if (failure.type === 'insufficient_scope') {
		const { scope } = failure;
		if (!isUpgrade) {
			c.header(
				'WWW-Authenticate',
				`Bearer error="insufficient_scope" scope="${scope}"`,
			);
			return c.json({ code: 'insufficient_scope', scope }, 403);
		}

		const pair = createWebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		server.accept();
		server.close(4403, JSON.stringify({ code: 'insufficient_scope', scope }));
		return new Response(null, { status: 101, webSocket: client });
	}

	if (!isUpgrade) {
		return c.json(AiChatError.Unauthorized(), 401);
	}

	const pair = createWebSocketPair();
	const [client, server] = [pair[0], pair[1]];
	server.accept();
	server.close(4401, JSON.stringify({ code: 'invalid_token' }));
	return new Response(null, { status: 101, webSocket: client });
}
