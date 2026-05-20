/**
 * Room Route Boundary Tests
 *
 * Verifies that the host route owns protected-resource authorization before
 * handing requests to the same-process sync engine.
 *
 * Key behaviors:
 * - `/rooms/:room` rejects unauthenticated callers at the OAuth resource
 *   boundary.
 * - The sync engine and room namespace are not touched when auth fails.
 */

import { expect, mock, test } from 'bun:test';
import { OAuthError } from './auth/oauth-error.js';

let createSyncEngineCalls = 0;
let durableObjectRoomFactoryCalls = 0;
let roomNamespaceCalls = 0;
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
}));

mock.module('./sync-engine', () => ({
	cloudflareDurableObjectRooms: () => {
		durableObjectRoomFactoryCalls += 1;
		return {
			get() {
				roomNamespaceCalls += 1;
				throw new Error('Room namespace should not be reached');
			},
		};
	},
	createSyncEngine: () => {
		createSyncEngineCalls += 1;
		throw new Error('Sync engine should not be created');
	},
}));

test('POST /rooms/:room rejects unauthenticated callers before sync engine entry', async () => {
	const { default: app } = await import('./app.js');
	const response = await app.fetch(
		new Request('https://api.test/rooms/notes', {
			method: 'POST',
			headers: { 'content-type': 'application/octet-stream' },
			body: new Uint8Array([1, 2, 3]),
		}),
		{
			HYPERDRIVE: { connectionString: 'postgres://test' },
			ROOM: {},
		},
		{
			waitUntil(promise: Promise<unknown>) {
				waitUntilPromises.push(promise);
			},
			passThroughOnException() {},
			props: {},
		},
	);

	await Promise.all(waitUntilPromises);

	expect(response.status).toBe(401);
	expect(response.headers.get('WWW-Authenticate')).toBe(
		'Bearer error="invalid_token"',
	);
	expect(resolveRequestOAuthUserCalls).toBe(1);
	expect(createSyncEngineCalls).toBe(0);
	expect(durableObjectRoomFactoryCalls).toBe(0);
	expect(roomNamespaceCalls).toBe(0);
});
