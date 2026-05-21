/**
 * Workspace Sync Doc Route Boundary Tests
 *
 * Verifies that `/workspaces/:workspaceId/apps/:appId/docs/:docId` rejects
 * unauthenticated callers at the auth middleware before any membership
 * lookup or sync engine work happens. Companion to `app.rooms.test.ts`.
 *
 * Key behaviors:
 * - WebSocket upgrade without a bearer subprotocol is rejected with a 101
 *   that immediately closes the upgraded socket with the OAuth 4401 code,
 *   and never reaches the workspace sync doc resolver, the sync engine, or
 *   the room gateway. This is the production behavior in
 *   `createOAuthUnauthorizedResourceResponse`. Catches a future call site
 *   that forgets to use `auth.openWebSocket` (which carries the bearer as
 *   a subprotocol so the server accepts the upgrade).
 * - POST without auth is rejected by the CSRF gate at 403 before auth even
 *   runs. POST with a trusted Origin but no auth is rejected at 401 by the
 *   auth middleware. Both paths leave the downstream untouched.
 */

import { expect, mock, test } from 'bun:test';
import { OAuthError } from './auth/oauth-error.js';
import { projectTrustedOAuthClientToRow } from './auth/trusted-oauth-clients.js';
import { TRUSTED_ORIGINS } from './trusted-origins.js';

// `WebSocketPair` is a Cloudflare Workers global. Bun's test runtime lacks
// it, so `createOAuthUnauthorizedResourceResponse`'s default factory throws.
// Shim with a constructor that tracks close calls; tests assert the code
// (4401) and reason payload that the production response would carry.
type ShimCloseCall = { code: number; reason: string };
class ShimWebSocket {
	accepted = false;
	closeCalls: ShimCloseCall[] = [];
	accept() {
		this.accepted = true;
	}
	close(code: number, reason: string) {
		this.closeCalls.push({ code, reason });
	}
}
class ShimWebSocketPair {
	0: ShimWebSocket;
	1: ShimWebSocket;
	constructor() {
		this[0] = new ShimWebSocket();
		this[1] = new ShimWebSocket();
		shimPairs.push(this);
	}
}
const shimPairs: ShimWebSocketPair[] = [];
// biome-ignore lint/suspicious/noExplicitAny: globalThis shim for test runtime
(globalThis as any).WebSocketPair ??= ShimWebSocketPair;

let createSyncEngineCalls = 0;
let durableObjectRoomFactoryCalls = 0;
let roomNamespaceCalls = 0;
let resolveAuthorizedWorkspaceSyncDocCalls = 0;
let resolveRequestOAuthUserCalls = 0;
const waitUntilPromises: Promise<unknown>[] = [];

mock.module('pg', () => ({
	default: {
		Client: class {
			async connect() {}
			async end() {}
		},
	},
}));

mock.module('drizzle-orm/node-postgres', () => ({
	drizzle: () => ({}),
}));

mock.module('./room', () => ({
	Room: class {},
}));

mock.module('./auth/create-auth', () => ({
	createAuth: () => ({
		api: {
			getSession: async () => null,
		},
		handler: async () => new Response(null, { status: 404 }),
	}),
}));

mock.module('./auth/encryption', () => ({
	deriveSubjectKeyring: async () => [],
}));

mock.module('./auth/resource-boundary', () => ({
	parseBearer: (authorization: string | null) => {
		const match = authorization?.match(/^Bearer\s+(.+)$/i);
		return match?.[1]?.trim() || null;
	},
	resolveRequestOAuthUser: async () => {
		resolveRequestOAuthUserCalls += 1;
		return { data: null, error: OAuthError.InvalidToken().error };
	},
}));

mock.module('./auth/trusted-oauth-clients', () => ({
	ensureTrustedOAuthClients: async () => {},
	projectTrustedOAuthClientToRow,
}));

mock.module('./workspace-sync-doc', () => ({
	resolveAuthorizedWorkspaceSyncDoc: async () => {
		resolveAuthorizedWorkspaceSyncDocCalls += 1;
		throw new Error('workspace-sync-doc resolver should not be reached');
	},
	buildWorkspaceSyncDocRoomName: () => 'unreachable',
}));

mock.module('./room-gateway', () => ({
	cloudflareDurableObjectRooms: () => {
		durableObjectRoomFactoryCalls += 1;
		return {
			sync() {
				roomNamespaceCalls += 1;
				throw new Error('Room gateway should not be reached');
			},
			getDoc() {
				roomNamespaceCalls += 1;
				throw new Error('Room gateway should not be reached');
			},
			handleWebSocket() {
				roomNamespaceCalls += 1;
				throw new Error('Room gateway should not be reached');
			},
			dispatch() {
				roomNamespaceCalls += 1;
				throw new Error('Room gateway should not be reached');
			},
		};
	},
}));

mock.module('./sync-engine', () => ({
	createSyncEngine: () => {
		createSyncEngineCalls += 1;
		throw new Error('Sync engine should not be created');
	},
}));

function resetCounters() {
	createSyncEngineCalls = 0;
	durableObjectRoomFactoryCalls = 0;
	roomNamespaceCalls = 0;
	resolveAuthorizedWorkspaceSyncDocCalls = 0;
	resolveRequestOAuthUserCalls = 0;
	waitUntilPromises.length = 0;
	shimPairs.length = 0;
}

function mockExecutionCtx() {
	return {
		waitUntil(promise: Promise<unknown>) {
			waitUntilPromises.push(promise);
		},
		passThroughOnException() {},
		props: {},
	};
}

function mockEnv() {
	return {
		HYPERDRIVE: { connectionString: 'postgres://test' },
		ROOM: {},
	};
}

test('WS upgrade without bearer subprotocol closes the upgraded socket with 4401', async () => {
	resetCounters();
	const { default: app } = await import('./app.js');

	// Browsers cannot set `Authorization` on `new WebSocket(url)` upgrades, so
	// the only smuggling channel is the `bearer.<token>` subprotocol. A
	// request that offers only the `epicenter` main subprotocol (no bearer)
	// and carries no cookie must be rejected at the auth boundary before any
	// membership check, sync engine creation, or room gateway access.
	const response = await app.fetch(
		new Request(
			'https://api.test/workspaces/ws_test/apps/fuji/docs/root',
			{
				method: 'GET',
				headers: {
					Upgrade: 'websocket',
					Connection: 'Upgrade',
					'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
					'Sec-WebSocket-Version': '13',
					'Sec-WebSocket-Protocol': 'epicenter',
				},
			},
		),
		mockEnv(),
		mockExecutionCtx(),
	);

	await Promise.all(waitUntilPromises);

	// Production behavior: HTTP 101 to complete the upgrade handshake; the
	// upgraded socket is then closed with the OAuth 4401 close code carrying
	// the typed error in its JSON reason.
	expect(response.status).toBe(101);
	expect(shimPairs).toHaveLength(1);
	const serverSocket = shimPairs[0]![1];
	expect(serverSocket.accepted).toBe(true);
	expect(serverSocket.closeCalls).toHaveLength(1);
	const close = serverSocket.closeCalls[0]!;
	expect(close.code).toBe(4401);
	expect(JSON.parse(close.reason)).toMatchObject({ name: 'InvalidToken' });

	// Downstream invariants: the bearer-less upgrade reached the auth check
	// and stopped there. Nothing past that point was instantiated.
	expect(resolveRequestOAuthUserCalls).toBe(1);
	expect(resolveAuthorizedWorkspaceSyncDocCalls).toBe(0);
	expect(createSyncEngineCalls).toBe(0);
	expect(durableObjectRoomFactoryCalls).toBe(0);
	expect(roomNamespaceCalls).toBe(0);
});

test('POST without Origin or auth is rejected by CSRF before auth runs', async () => {
	resetCounters();
	const { default: app } = await import('./app.js');

	// `requireOriginForCookieMutations` on `/workspaces/*` rejects state-
	// changing requests that carry neither a bearer nor a trusted Origin.
	// This protects cookie-auth POSTs from cross-site forgery; bearer
	// requests skip this gate because the attacker page cannot read the
	// bearer to construct the Authorization header.
	const response = await app.fetch(
		new Request(
			'https://api.test/workspaces/ws_test/apps/fuji/docs/root',
			{
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream' },
				body: new Uint8Array([1, 2, 3]),
			},
		),
		mockEnv(),
		mockExecutionCtx(),
	);

	await Promise.all(waitUntilPromises);

	expect(response.status).toBe(403);
	expect(resolveRequestOAuthUserCalls).toBe(0);
	expect(resolveAuthorizedWorkspaceSyncDocCalls).toBe(0);
	expect(createSyncEngineCalls).toBe(0);
	expect(durableObjectRoomFactoryCalls).toBe(0);
});

test('POST with trusted Origin but no auth is rejected at the auth boundary', async () => {
	resetCounters();
	const { default: app } = await import('./app.js');

	// Pass the CSRF gate with a trusted Origin so the test exercises the
	// next layer: requireCookieOrBearerUser sees no cookie and no bearer,
	// resolveRequestOAuthUser returns InvalidToken, and the auth middleware
	// answers 401 with the OAuth WWW-Authenticate header.
	const trustedOrigin = TRUSTED_ORIGINS[0]!;
	const response = await app.fetch(
		new Request(
			'https://api.test/workspaces/ws_test/apps/fuji/docs/root',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/octet-stream',
					Origin: trustedOrigin,
				},
				body: new Uint8Array([1, 2, 3]),
			},
		),
		mockEnv(),
		mockExecutionCtx(),
	);

	await Promise.all(waitUntilPromises);

	expect(response.status).toBe(401);
	expect(response.headers.get('WWW-Authenticate')).toBe(
		'Bearer error="invalid_token"',
	);
	expect(resolveRequestOAuthUserCalls).toBe(1);
	expect(resolveAuthorizedWorkspaceSyncDocCalls).toBe(0);
	expect(createSyncEngineCalls).toBe(0);
	expect(durableObjectRoomFactoryCalls).toBe(0);
	expect(roomNamespaceCalls).toBe(0);
});
