import { describe, expect, test } from 'bun:test';
import { asOwnerId } from '@epicenter/identity';
import { BEARER_SUBPROTOCOL_PREFIX } from '@epicenter/sync';
import type { AuthFetch } from './auth-contract.js';
import { asUserId } from './index.js';
import { createInstanceTokenAuth } from './instance-token-auth.js';

const baseURL = 'http://localhost:8788';
const token = 'dev:owner-1';

function sessionBody(ownerId = 'owner-1') {
	return {
		user: { id: ownerId, email: `${ownerId}@example.com` },
		ownerId,
	};
}

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/** Let the construction-time `/api/session` check settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createInstanceTokenAuth', () => {
	test('boots signed-in from /api/session 200 with the instance bearer', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });

		expect(auth.state.status).toBe('signed-out'); // before the async check resolves
		await flush();

		expect(auth.state).toEqual({
			status: 'signed-in',
			ownerId: asOwnerId('owner-1'),
		});
		expect(calls[0]?.url).toBe(`${baseURL}/api/session`);
		expect(calls[0]?.init?.credentials).toBe('omit');
		expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(
			`Bearer ${token}`,
		);
	});

	test('boots signed-out when /api/session rejects the token (401)', async () => {
		const fetch: AuthFetch = async () => json({}, 401);
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-out');
	});

	test('fetch attaches the bearer to the instance origin and resolves relative paths', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();

		await auth.fetch('/api/owners/owner-1/blobs');
		const blobs = calls.at(-1);
		expect(blobs?.url).toBe(`${baseURL}/api/owners/owner-1/blobs`);
		expect(blobs?.init?.credentials).toBe('omit');
		expect(new Headers(blobs?.init?.headers).get('authorization')).toBe(
			`Bearer ${token}`,
		);
	});

	test('fetch never attaches the bearer to a different origin (audience scoping)', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();

		await auth.fetch('https://someone-elses-inference.example.com/v1/models');
		const cross = calls.at(-1);
		expect(cross?.url).toBe(
			'https://someone-elses-inference.example.com/v1/models',
		);
		expect(new Headers(cross?.init?.headers).has('authorization')).toBe(false);
	});

	test('a 401 on a resource call moves a signed-in client to signed-out', async () => {
		const fetch: AuthFetch = async (input) =>
			String(input).endsWith('/api/session')
				? json(sessionBody())
				: json({}, 401);
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-in');

		await auth.fetch('/api/owners/owner-1/blobs');
		expect(auth.state.status).toBe('signed-out');
	});

	test('openWebSocket carries the bearer as an Epicenter subprotocol', async () => {
		const wsCalls: Array<{ url: string; protocols: string[] }> = [];
		class FakeWebSocket {
			constructor(url: string, protocols: string[]) {
				wsCalls.push({ url, protocols });
			}
		}
		const fetch: AuthFetch = async () => json(sessionBody());
		const auth = createInstanceTokenAuth({
			baseURL,
			token,
			fetch,
			WebSocket: FakeWebSocket as unknown as typeof WebSocket,
		});
		await flush();

		await auth.openWebSocket('ws://localhost:8788/api/owners/owner-1/rooms/r', [
			'existing-protocol',
		]);
		expect(wsCalls.at(-1)).toEqual({
			url: 'ws://localhost:8788/api/owners/owner-1/rooms/r',
			protocols: ['existing-protocol', `${BEARER_SUBPROTOCOL_PREFIX}${token}`],
		});
	});

	test('signOut drops to signed-out locally without a server call', async () => {
		const calls: string[] = [];
		const fetch: AuthFetch = async (input) => {
			calls.push(String(input));
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-in');
		const callsBefore = calls.length;

		await auth.signOut();
		expect(auth.state.status).toBe('signed-out');
		expect(calls.length).toBe(callsBefore); // no revoke request
	});

	test('startSignIn re-verifies the token (retry after an offline boot)', async () => {
		let reachable = false;
		const fetch: AuthFetch = async () => {
			if (!reachable) throw new Error('offline');
			return json(sessionBody());
		};
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-out');

		reachable = true;
		const { error } = await auth.startSignIn();
		expect(error).toBeNull();
		expect(auth.state).toEqual({
			status: 'signed-in',
			ownerId: asOwnerId('owner-1'),
		});
	});

	test('getProfile reads the user from /api/session with the bearer', async () => {
		const fetch: AuthFetch = async () => json(sessionBody());
		const auth = createInstanceTokenAuth({ baseURL, token, fetch });
		await flush();

		const { data, error } = await auth.getProfile();
		expect(error).toBeNull();
		expect(data).toEqual({
			id: asUserId('owner-1'),
			email: 'owner-1@example.com',
		});
	});
});
