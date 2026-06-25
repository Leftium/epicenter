import { describe, expect, test } from 'bun:test';
import { asOwnerId } from '@epicenter/identity';
import type { AuthFetch } from './auth-contract.js';
import { getSession, normalizeInstanceUrl } from './instance.js';

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

describe('normalizeInstanceUrl', () => {
	test('defaults a missing scheme to https', () => {
		const { data } = normalizeInstanceUrl('epicenter.example.com');
		expect(data).toBe('https://epicenter.example.com');
	});

	test('preserves an explicit http scheme (localhost self-host)', () => {
		const { data } = normalizeInstanceUrl('http://localhost:8788');
		expect(data).toBe('http://localhost:8788');
	});

	test('strips a trailing slash, query, and hash', () => {
		const { data } = normalizeInstanceUrl('https://host.example.com/?a=1#x');
		expect(data).toBe('https://host.example.com');
	});

	test('preserves a path prefix', () => {
		const { data } = normalizeInstanceUrl('https://host.example.com/epicenter/');
		expect(data).toBe('https://host.example.com/epicenter');
	});

	test('rejects empty input', () => {
		const { data, error } = normalizeInstanceUrl('   ');
		expect(data).toBeNull();
		expect(error?.name).toBe('InvalidUrl');
	});

	test('rejects a non-http(s) scheme', () => {
		const { error } = normalizeInstanceUrl('ftp://host.example.com');
		expect(error?.name).toBe('InvalidUrl');
	});
});

describe('getSession', () => {
	const baseURL = 'http://localhost:8788';

	test('returns the session on a 200, sending the bearer when given a token', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json({
				user: { id: 'owner-1', email: 'owner-1@example.com' },
				ownerId: 'owner-1',
			});
		};
		const { data, error } = await getSession({
			baseURL,
			token: 'dev:owner-1',
			fetch,
		});
		expect(error).toBeNull();
		expect(data?.ownerId).toBe(asOwnerId('owner-1'));
		expect(data?.user.email).toBe('owner-1@example.com');
		expect(calls[0]?.url).toBe(`${baseURL}/api/session`);
		expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(
			'Bearer dev:owner-1',
		);
	});

	test('omits the Authorization header when no token is given', async () => {
		const calls: Array<{ init?: RequestInit }> = [];
		const fetch: AuthFetch = async (_input, init) => {
			calls.push({ init });
			return json({
				user: { id: 'owner-1', email: 'owner-1@example.com' },
				ownerId: 'owner-1',
			});
		};
		await getSession({ baseURL, fetch });
		expect(new Headers(calls[0]?.init?.headers).has('authorization')).toBe(false);
	});

	test('maps a rejected token (401/403) to InvalidToken', async () => {
		const fetch: AuthFetch = async () => json({}, 401);
		const { error } = await getSession({ baseURL, token: 'bad', fetch });
		expect(error?.name).toBe('InvalidToken');
	});

	test('maps a no-token 401/403 to Unauthenticated, not InvalidToken', async () => {
		const fetch: AuthFetch = async () => json({}, 401);
		const { error } = await getSession({ baseURL, fetch });
		expect(error?.name).toBe('Unauthenticated');
	});

	test('maps a thrown fetch to Unreachable', async () => {
		const fetch: AuthFetch = async () => {
			throw new Error('ECONNREFUSED');
		};
		const { error } = await getSession({ baseURL, token: 'x', fetch });
		expect(error?.name).toBe('Unreachable');
	});

	test('maps an unexpected status to Unexpected', async () => {
		const fetch: AuthFetch = async () => json({}, 500);
		const { error } = await getSession({ baseURL, token: 'x', fetch });
		expect(error?.name).toBe('Unexpected');
	});
});
