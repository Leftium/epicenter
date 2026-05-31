/**
 * WebSocket Auth Normalization Tests
 *
 * `normalizeWebSocketAuth` is a pure transport normalizer: on a WebSocket
 * upgrade it drops the ambient cookie (a WS upgrade is bearer-only in this
 * product) and lifts a single `bearer.<token>` subprotocol entry into
 * `Authorization`. It never authenticates and never rejects; a missing,
 * empty, or duplicate bearer attaches nothing and downstream bearer auth
 * answers 401. Non-upgrade requests pass through untouched.
 */

import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { normalizeWebSocketAuth } from './websocket-auth.js';

function createTestApp() {
	const app = new Hono();
	app.use('*', normalizeWebSocketAuth);
	app.get('/', (c) =>
		c.json({
			authorization: c.req.header('authorization') ?? null,
			cookie: c.req.header('cookie') ?? null,
			subprotocol: c.req.header('sec-websocket-protocol') ?? null,
		}),
	);
	return app;
}

// --- Non-upgrade requests: untouched (the auth layer owns cookie-vs-bearer) ---

test('non-upgrade request with cookie + bearer passes through untouched', async () => {
	const res = await createTestApp().request('/', {
		headers: {
			authorization: 'Bearer token-1',
			cookie: 'better-auth.session_token=session-1',
		},
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	// No edge rejection: cookie-vs-bearer is resolved by the auth middleware,
	// not policed here.
	expect(body.authorization).toBe('Bearer token-1');
	expect(body.cookie).toContain('better-auth.session_token=session-1');
});

test('non-upgrade request with cookie only passes through untouched', async () => {
	const res = await createTestApp().request('/', {
		headers: { cookie: 'better-auth.session_token=session-1' },
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	expect(body.cookie).toContain('better-auth.session_token=session-1');
	expect(body.authorization).toBeNull();
});

test('non-upgrade request with a bearer subprotocol is NOT lifted', async () => {
	const res = await createTestApp().request('/', {
		headers: { 'sec-websocket-protocol': 'epicenter, bearer.token-1' },
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	// The lift only applies to real upgrades; a stray subprotocol header on a
	// plain GET is left alone.
	expect(body.authorization).toBeNull();
	expect(body.subprotocol).toBe('epicenter, bearer.token-1');
});

// --- WebSocket upgrades: cookie dropped, bearer lifted ---

test('upgrade with cookie + WS bearer drops the cookie and lifts the bearer', async () => {
	const res = await createTestApp().request('/', {
		headers: {
			cookie: 'better-auth.session_token=session-1',
			'sec-websocket-protocol': 'epicenter, bearer.token-1',
			upgrade: 'websocket',
		},
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	expect(body.authorization).toBe('Bearer token-1');
	expect(body.cookie).toBeNull();
	expect(body.subprotocol).toBe('epicenter');
});

test('upgrade with cookie but no bearer drops the cookie and attaches nothing', async () => {
	const res = await createTestApp().request('/', {
		headers: {
			cookie: 'better-auth.session_token=session-1',
			'sec-websocket-protocol': 'epicenter',
			upgrade: 'websocket',
		},
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	// Cookie is ambient noise on a bearer-only channel: dropped unconditionally.
	// No bearer to lift, so downstream auth will 401.
	expect(body.cookie).toBeNull();
	expect(body.authorization).toBeNull();
	expect(body.subprotocol).toBe('epicenter');
});

test('upgrade with only a WS bearer lifts it and strips it from the protocol', async () => {
	const res = await createTestApp().request('/', {
		headers: {
			'sec-websocket-protocol': 'epicenter, bearer.token-1',
			upgrade: 'websocket',
		},
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	expect(body.authorization).toBe('Bearer token-1');
	expect(body.subprotocol).toBe('epicenter');
});

test('upgrade with a bearer-only subprotocol drops the protocol header entirely', async () => {
	const res = await createTestApp().request('/', {
		headers: {
			'sec-websocket-protocol': 'bearer.token-1',
			upgrade: 'websocket',
		},
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	expect(body.authorization).toBe('Bearer token-1');
	expect(body.subprotocol).toBeNull();
});

test('upgrade with explicit Authorization keeps it and consumes the WS bearer', async () => {
	const res = await createTestApp().request('/', {
		headers: {
			authorization: 'Bearer explicit-token',
			cookie: 'better-auth.session_token=session-1',
			'sec-websocket-protocol': 'epicenter, bearer.subproto-token',
			upgrade: 'websocket',
		},
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	expect(body.authorization).toBe('Bearer explicit-token');
	expect(body.cookie).toBeNull();
	expect(body.subprotocol).toBe('epicenter');
});

// --- WebSocket upgrades: never authenticates, never rejects ---

test('upgrade with two WS bearers attaches nothing (downstream 401), no throw', async () => {
	const res = await createTestApp().request('/', {
		headers: {
			cookie: 'better-auth.session_token=session-1',
			'sec-websocket-protocol': 'epicenter, bearer.token-1, bearer.token-2',
			upgrade: 'websocket',
		},
	});

	// No 400: the normalizer never owns a status. A malformed client attaches
	// nothing and bearer auth answers 401.
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	expect(body.authorization).toBeNull();
	expect(body.cookie).toBeNull();
});

test('upgrade with an empty bearer. token attaches nothing', async () => {
	const res = await createTestApp().request('/', {
		headers: {
			'sec-websocket-protocol': 'epicenter, bearer.',
			upgrade: 'websocket',
		},
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	// Empty token is not a credential: no junk `Authorization: Bearer ` header.
	expect(body.authorization).toBeNull();
});

test('upgrade with no credentials passes through cleanly', async () => {
	const res = await createTestApp().request('/', {
		headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'epicenter' },
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, string | null>;
	expect(body.authorization).toBeNull();
	expect(body.cookie).toBeNull();
	expect(body.subprotocol).toBe('epicenter');
});
