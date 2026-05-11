/**
 * OAuth Resource Response Tests
 *
 * Verifies protected app resource auth failures at the API boundary.
 *
 * Key behaviors:
 * - HTTP resource requests receive a normal unauthorized JSON response
 * - WebSocket resource requests are accepted only to close with auth code 4401
 */

import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { createOAuthUnauthorizedResourceResponse } from './oauth-resource.js';

test('HTTP resource auth failure returns unauthorized JSON', async () => {
	const app = new Hono();
	app.get('/resource', (c) => createOAuthUnauthorizedResourceResponse(c));

	const response = await app.request('/resource');

	expect(response.status).toBe(401);
	await expect(response.json()).resolves.toEqual({
		data: null,
		error: {
			message: 'Unauthorized',
			name: 'Unauthorized',
		},
	});
});

test('WebSocket resource auth failure closes with 4401 invalid token', async () => {
	const closeCalls: Array<{ code?: number; reason?: string }> = [];
	let accepted = false;
	const server = {
		accept() {
			accepted = true;
		},
		close(code?: number, reason?: string) {
			closeCalls.push({ code, reason });
		},
	} satisfies Pick<WebSocket, 'accept' | 'close'>;
	const app = new Hono();
	app.get('/resource', (c) =>
		createOAuthUnauthorizedResourceResponse(c, {
			createWebSocketPair: () => ({
				0: {} as WebSocket,
				1: server as WebSocket,
			}),
		}),
	);

	const response = await app.request('/resource', {
		headers: { upgrade: 'websocket' },
	});

	expect(response.status).toBe(101);
	expect(accepted).toBe(true);
	expect(closeCalls).toEqual([
		{ code: 4401, reason: JSON.stringify({ code: 'invalid_token' }) },
	]);
});
