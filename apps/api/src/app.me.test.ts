/**
 * Default-Workspace Sync Doc Route Boundary Tests
 *
 * Verifies that `/me/apps/:appId/docs/:docId` and its POST siblings:
 *
 *   - Reject unauthenticated callers at the auth middleware, never reaching
 *     the default-workspace resolver.
 *   - Resolve the workspace id from the auth-token-derived personal workspace
 *     when the user is signed in and a default workspace exists.
 *   - Close the WebSocket upgrade with code 4401 and JSON reason
 *     `{ code: 'no_default_workspace' }` when the user has no default
 *     workspace, so the supervisor's `parsePermanentFailure` parks the
 *     connection in `failed` instead of retrying with backoff.
 *   - Respond with HTTP 409 + `{ name: 'PersonalWorkspaceMissing', message }`
 *     on the non-upgrade variants so the response shape matches what the
 *     existing `/api/workspaces` endpoint already returns.
 */

import { expect, mock, test } from 'bun:test';
import { OAuthError } from './auth/oauth-error.js';
import { projectTrustedOAuthClientToRow } from './auth/trusted-oauth-clients.js';
import { TRUSTED_ORIGINS } from './trusted-origins.js';

// `WebSocketPair` is a Cloudflare Workers global. Bun's test runtime lacks it,
// so the production close-upgrade-with-reason helper throws without a shim.
// The shim mirrors the constructor enough to assert the close-code + reason
// the supervisor will parse.
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
// Use `=` rather than `??=`: other test files in this project (presence.test.ts)
// install their own `WebSocketPair` global with a different `WebSocket` shape.
// Whichever test file runs first wins under `??=`, which produces opaque
// "accept is not a function" failures depending on file order.
// biome-ignore lint/suspicious/noExplicitAny: globalThis shim for test runtime
(globalThis as any).WebSocketPair = ShimWebSocketPair;

type ResolverResult =
	| { data: { workspaceId: string; appId: string; docId: string; roomName: string; syncDocResourceName: string }; error?: never }
	| {
			data?: never;
			error: {
				name:
					| 'InvalidWorkspaceSyncDoc'
					| 'WorkspaceForbidden'
					| 'PersonalWorkspaceMissing';
				message: string;
				status: 400 | 403 | 409;
			};
	  };

let signedInUser: { id: string; email: string } | null = null;
let nextResolverResult: ResolverResult = {
	error: {
		name: 'PersonalWorkspaceMissing',
		message: 'unset',
		status: 409,
	},
};
let resolveDefaultCalls = 0;
let resolveExplicitCalls = 0;
let handleWebSocketCalls = 0;
let dispatchCalls = 0;
let httpSyncCalls = 0;
let snapshotCalls = 0;
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

// Stub Drizzle just enough that `upsertDoInstance` (fire-and-forget telemetry)
// returns a resolved promise instead of throwing on `db.insert(...)`. The
// route tests don't assert on DO-instance rows; they assert on the
// route -> resolver -> sync-engine boundary.
const stubInsertBuilder = {
	values() {
		return stubInsertBuilder;
	},
	onConflictDoUpdate() {
		return Promise.resolve();
	},
	catch() {
		return Promise.resolve();
	},
};
mock.module('drizzle-orm/node-postgres', () => ({
	drizzle: () => ({
		insert: () => stubInsertBuilder,
	}),
}));

mock.module('./room', () => ({
	Room: class {},
}));

mock.module('./auth/create-auth', () => ({
	createAuth: () => ({
		api: {
			getSession: async () =>
				signedInUser ? { user: signedInUser } : null,
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
		resolveExplicitCalls += 1;
		throw new Error(
			'explicit-workspace resolver must not be reached from /me routes',
		);
	},
	resolveAuthorizedDefaultWorkspaceSyncDoc: async () => {
		resolveDefaultCalls += 1;
		return nextResolverResult;
	},
	buildWorkspaceSyncDocRoomName: () => 'unreachable',
}));

mock.module('./room-gateway', () => ({
	cloudflareDurableObjectRooms: () => ({
		sync() {
			throw new Error('Room gateway sync should not be reached');
		},
		getDoc() {
			throw new Error('Room gateway getDoc should not be reached');
		},
		handleWebSocket(roomName: string) {
			handleWebSocketCalls += 1;
			return new Response(`upgraded:${roomName}`, { status: 101 });
		},
		dispatch(roomName: string, body: unknown) {
			dispatchCalls += 1;
			return { ok: true, roomName, body };
		},
	}),
}));

mock.module('./sync-engine', () => ({
	createSyncEngine: () => ({
		async getSnapshot(roomName: string) {
			snapshotCalls += 1;
			return {
				response: new Response(`snapshot:${roomName}`, { status: 200 }),
				storageBytes: 42,
			};
		},
		async handleHttpSync(_req: Request, params: { roomName: string }) {
			httpSyncCalls += 1;
			return {
				response: new Response(`sync:${params.roomName}`, { status: 200 }),
				storageBytes: 7,
			};
		},
	}),
}));

function resetCounters() {
	resolveDefaultCalls = 0;
	resolveExplicitCalls = 0;
	handleWebSocketCalls = 0;
	dispatchCalls = 0;
	httpSyncCalls = 0;
	snapshotCalls = 0;
	resolveRequestOAuthUserCalls = 0;
	waitUntilPromises.length = 0;
	shimPairs.length = 0;
	signedInUser = null;
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

function asSignedIn(user: { id: string; email: string }) {
	signedInUser = user;
}

const TRUSTED_ORIGIN = TRUSTED_ORIGINS[0]!;

test('WS upgrade to /me/apps/:appId/docs/:docId without auth closes 4401 before the resolver runs', async () => {
	resetCounters();
	const { default: app } = await import('./app.js');

	const response = await app.fetch(
		new Request('https://api.test/me/apps/fuji/docs/root', {
			method: 'GET',
			headers: {
				Upgrade: 'websocket',
				Connection: 'Upgrade',
				'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version': '13',
				'Sec-WebSocket-Protocol': 'epicenter',
			},
		}),
		mockEnv(),
		mockExecutionCtx(),
	);

	await Promise.all(waitUntilPromises);

	// Upgrade completes (HTTP 101) but the upgraded socket carries the OAuth
	// InvalidToken close: this is the auth middleware doing its job; the
	// default-workspace resolver never runs.
	expect(response.status).toBe(101);
	expect(shimPairs).toHaveLength(1);
	const close = shimPairs[0]![1].closeCalls[0]!;
	expect(close.code).toBe(4401);
	expect(JSON.parse(close.reason)).toMatchObject({ name: 'InvalidToken' });

	expect(resolveRequestOAuthUserCalls).toBe(1);
	expect(resolveDefaultCalls).toBe(0);
	expect(handleWebSocketCalls).toBe(0);
});

test('POST /me/apps/:appId/docs/:docId without auth is rejected by CSRF before auth runs', async () => {
	resetCounters();
	const { default: app } = await import('./app.js');

	const response = await app.fetch(
		new Request('https://api.test/me/apps/fuji/docs/root', {
			method: 'POST',
			headers: { 'content-type': 'application/octet-stream' },
			body: new Uint8Array([1, 2, 3]),
		}),
		mockEnv(),
		mockExecutionCtx(),
	);

	await Promise.all(waitUntilPromises);

	expect(response.status).toBe(403);
	expect(resolveDefaultCalls).toBe(0);
	expect(httpSyncCalls).toBe(0);
});

test('POST /me/apps/:appId/docs/:docId with trusted Origin but no auth returns 401', async () => {
	resetCounters();
	const { default: app } = await import('./app.js');

	const response = await app.fetch(
		new Request('https://api.test/me/apps/fuji/docs/root', {
			method: 'POST',
			headers: {
				'content-type': 'application/octet-stream',
				Origin: TRUSTED_ORIGIN,
			},
			body: new Uint8Array([1, 2, 3]),
		}),
		mockEnv(),
		mockExecutionCtx(),
	);

	await Promise.all(waitUntilPromises);

	expect(response.status).toBe(401);
	expect(resolveDefaultCalls).toBe(0);
	expect(httpSyncCalls).toBe(0);
});

test('WS upgrade for a signed-in user with a default workspace forwards to handleWebSocket', async () => {
	resetCounters();
	asSignedIn({ id: 'user_1', email: 'user_1@example.com' });
	nextResolverResult = {
		data: {
			workspaceId: 'ws_default',
			appId: 'fuji',
			docId: 'root',
			roomName: 'v1:workspace:ws_default:app:fuji:doc:root',
			syncDocResourceName: 'ws_default/fuji/root',
		},
	};
	const { default: app } = await import('./app.js');

	const response = await app.fetch(
		new Request('https://api.test/me/apps/fuji/docs/root', {
			method: 'GET',
			headers: {
				Upgrade: 'websocket',
				Connection: 'Upgrade',
				'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version': '13',
				'Sec-WebSocket-Protocol': 'epicenter',
			},
		}),
		mockEnv(),
		mockExecutionCtx(),
	);

	await Promise.all(waitUntilPromises);

	expect(response.status).toBe(101);
	expect(await response.text()).toBe(
		'upgraded:v1:workspace:ws_default:app:fuji:doc:root',
	);
	expect(resolveDefaultCalls).toBe(1);
	expect(handleWebSocketCalls).toBe(1);
	// No WS close-with-reason shim was ever instantiated; the upgrade is the
	// real WebSocket handshake delegated to the room gateway.
	expect(shimPairs).toHaveLength(0);
});

test('WS upgrade for a signed-in user with no default workspace closes 4401 with no_default_workspace', async () => {
	resetCounters();
	asSignedIn({ id: 'user_2', email: 'user_2@example.com' });
	nextResolverResult = {
		error: {
			name: 'PersonalWorkspaceMissing',
			message: 'Your personal Cloud Workspace is missing.',
			status: 409,
		},
	};
	const { default: app } = await import('./app.js');

	const response = await app.fetch(
		new Request('https://api.test/me/apps/fuji/docs/root', {
			method: 'GET',
			headers: {
				Upgrade: 'websocket',
				Connection: 'Upgrade',
				'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version': '13',
				'Sec-WebSocket-Protocol': 'epicenter',
			},
		}),
		mockEnv(),
		mockExecutionCtx(),
	);

	await Promise.all(waitUntilPromises);

	// The route accepts the upgrade and immediately closes with a structured
	// reason; refusing the upgrade would look like a transient network blip
	// and trigger backoff in the supervisor.
	expect(response.status).toBe(101);
	expect(shimPairs).toHaveLength(1);
	const serverSocket = shimPairs[0]![1];
	expect(serverSocket.accepted).toBe(true);
	expect(serverSocket.closeCalls).toHaveLength(1);
	const close = serverSocket.closeCalls[0]!;
	expect(close.code).toBe(4401);
	expect(JSON.parse(close.reason)).toEqual({ code: 'no_default_workspace' });

	expect(resolveDefaultCalls).toBe(1);
	expect(handleWebSocketCalls).toBe(0);
});

test('POST /me/apps/:appId/docs/:docId for a signed-in user with no default returns 409 JSON', async () => {
	resetCounters();
	asSignedIn({ id: 'user_3', email: 'user_3@example.com' });
	nextResolverResult = {
		error: {
			name: 'PersonalWorkspaceMissing',
			message: 'Your personal Cloud Workspace is missing.',
			status: 409,
		},
	};
	const { default: app } = await import('./app.js');

	const response = await app.fetch(
		new Request('https://api.test/me/apps/fuji/docs/root', {
			method: 'POST',
			headers: {
				'content-type': 'application/octet-stream',
				Origin: TRUSTED_ORIGIN,
			},
			body: new Uint8Array([1, 2, 3]),
		}),
		mockEnv(),
		mockExecutionCtx(),
	);

	await Promise.all(waitUntilPromises);

	expect(response.status).toBe(409);
	expect(await response.json()).toEqual({
		name: 'PersonalWorkspaceMissing',
		message: 'Your personal Cloud Workspace is missing.',
	});
	expect(httpSyncCalls).toBe(0);
});

test('POST /me/apps/:appId/docs/:docId for a signed-in user with default forwards to sync engine', async () => {
	resetCounters();
	asSignedIn({ id: 'user_4', email: 'user_4@example.com' });
	nextResolverResult = {
		data: {
			workspaceId: 'ws_default',
			appId: 'fuji',
			docId: 'root',
			roomName: 'v1:workspace:ws_default:app:fuji:doc:root',
			syncDocResourceName: 'ws_default/fuji/root',
		},
	};
	const { default: app } = await import('./app.js');

	const response = await app.fetch(
		new Request('https://api.test/me/apps/fuji/docs/root', {
			method: 'POST',
			headers: {
				'content-type': 'application/octet-stream',
				Origin: TRUSTED_ORIGIN,
			},
			body: new Uint8Array([1, 2, 3]),
		}),
		mockEnv(),
		mockExecutionCtx(),
	);

	await Promise.all(waitUntilPromises);

	expect(response.status).toBe(200);
	expect(await response.text()).toBe(
		'sync:v1:workspace:ws_default:app:fuji:doc:root',
	);
	expect(httpSyncCalls).toBe(1);
});

test('POST /me/apps/:appId/docs/:docId/dispatch for a signed-in user routes through the room gateway', async () => {
	resetCounters();
	asSignedIn({ id: 'user_5', email: 'user_5@example.com' });
	nextResolverResult = {
		data: {
			workspaceId: 'ws_default',
			appId: 'fuji',
			docId: 'root',
			roomName: 'v1:workspace:ws_default:app:fuji:doc:root',
			syncDocResourceName: 'ws_default/fuji/root',
		},
	};
	const { default: app } = await import('./app.js');

	const response = await app.fetch(
		new Request('https://api.test/me/apps/fuji/docs/root/dispatch', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				Origin: TRUSTED_ORIGIN,
			},
			body: JSON.stringify({
				from: 'device-a',
				to: 'device-b',
				action: 'ping',
				input: { ok: true },
			}),
		}),
		mockEnv(),
		mockExecutionCtx(),
	);

	await Promise.all(waitUntilPromises);

	expect(response.status).toBe(200);
	const body = (await response.json()) as { ok: boolean; roomName: string };
	expect(body.ok).toBe(true);
	expect(body.roomName).toBe('v1:workspace:ws_default:app:fuji:doc:root');
	expect(dispatchCalls).toBe(1);
});
