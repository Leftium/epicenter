import { describe, expect, test } from 'bun:test';
import { asOwnerId } from '@epicenter/identity';
import type { AuthFetch } from './auth-contract.js';
import { createSameOriginCookieAuth } from './same-origin-cookie-auth.js';

const baseURL = 'https://api.epicenter.so';

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

describe('createSameOriginCookieAuth', () => {
	test('boots signed-in from /api/session 200, cookie-credentialed and bearer-free', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json(sessionBody());
		};
		const auth = createSameOriginCookieAuth({ baseURL, fetch });

		expect(auth.state.status).toBe('signed-out'); // before the async check resolves
		await flush();

		expect(auth.state).toEqual({
			status: 'signed-in',
			ownerId: asOwnerId('owner-1'),
		});
		expect(calls[0]?.url).toBe(`${baseURL}/api/session`);
		expect(calls[0]?.init?.credentials).toBe('include');
		expect(new Headers(calls[0]?.init?.headers).has('authorization')).toBe(
			false,
		);
	});

	test('boots signed-out from /api/session 401', async () => {
		const fetch: AuthFetch = async () => json({}, 401);
		const auth = createSameOriginCookieAuth({ baseURL, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-out');
	});

	test('fetch sends the cookie, no Authorization, and resolves relative paths', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json(sessionBody());
		};
		const auth = createSameOriginCookieAuth({ baseURL, fetch });
		await flush();

		await auth.fetch('/api/billing/overview');
		const billing = calls.at(-1);
		expect(billing?.url).toBe(`${baseURL}/api/billing/overview`);
		expect(billing?.init?.credentials).toBe('include');
		expect(new Headers(billing?.init?.headers).has('authorization')).toBe(
			false,
		);
	});

	test('a 401 on a resource call moves a signed-in client to signed-out', async () => {
		const fetch: AuthFetch = async (input) =>
			String(input).endsWith('/api/session')
				? json(sessionBody())
				: json({}, 401);
		const auth = createSameOriginCookieAuth({ baseURL, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-in');

		await auth.fetch('/api/billing/overview');
		expect(auth.state.status).toBe('signed-out');
	});

	test('startSignIn navigates to the hosted sign-in with the relative callbackURL', async () => {
		const fetch: AuthFetch = async () => json({}, 401);
		const navigations: string[] = [];
		const auth = createSameOriginCookieAuth({
			baseURL,
			fetch,
			navigate: (url) => navigations.push(url),
			callbackURL: '/dashboard/',
		});
		await flush();

		await auth.startSignIn();
		expect(navigations[0]).toBe(
			`${baseURL}/sign-in?callbackURL=${encodeURIComponent('/dashboard/')}`,
		);
	});

	test('signOut posts to /auth/sign-out and goes signed-out', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return String(input).endsWith('/api/session')
				? json(sessionBody())
				: new Response(null, { status: 200 });
		};
		const auth = createSameOriginCookieAuth({ baseURL, fetch });
		await flush();
		expect(auth.state.status).toBe('signed-in');

		await auth.signOut();
		const signOut = calls.at(-1);
		expect(signOut?.url).toBe(`${baseURL}/auth/sign-out`);
		expect(signOut?.init?.method).toBe('POST');
		expect(auth.state.status).toBe('signed-out');
	});
});
