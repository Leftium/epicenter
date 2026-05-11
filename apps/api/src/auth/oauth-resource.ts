import { AiChatError } from '@epicenter/constants/ai-chat-errors';
import type { Context } from 'hono';

type WebSocketPairLike = {
	0: WebSocket;
	1: {
		accept(): void;
		close(code?: number, reason?: string): void;
	};
};

type OAuthUnauthorizedResourceResponseOptions = {
	createWebSocketPair?: () => WebSocketPairLike;
};

export function createOAuthUnauthorizedResourceResponse(
	c: Context,
	{
		createWebSocketPair = () => new WebSocketPair() as WebSocketPairLike,
	}: OAuthUnauthorizedResourceResponseOptions = {},
) {
	if (c.req.header('upgrade') !== 'websocket') {
		return c.json(AiChatError.Unauthorized(), 401);
	}

	const pair = createWebSocketPair();
	const [client, server] = [pair[0], pair[1]];
	server.accept();
	server.close(4401, JSON.stringify({ code: 'invalid_token' }));
	return new Response(null, { status: 101, webSocket: client });
}
