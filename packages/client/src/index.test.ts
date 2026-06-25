import { afterEach, describe, expect, test } from 'bun:test';
import { asOwnerId } from '@epicenter/identity';
import { createEpicenterClient } from './index.js';

const baseURL = 'https://api.epicenter.so';

describe('blobs.add fails closed', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test('a 401 on the upload ticket returns an error and never PUTs bytes', async () => {
		// The owner-scoped client trusts its construction owner, but the first
		// authed request (the ticket POST) is where auth verifies it: on an owner
		// mismatch the auth client wipes the cell and withholds the bearer, so that
		// POST comes back 401. The client must stop there, before streaming any
		// bytes to the store. The store PUT goes through the global `fetch`, so we
		// fail the test if it is ever reached.
		let putReached = false;
		globalThis.fetch = (async () => {
			putReached = true;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		const ticketCalls: string[] = [];
		const client = createEpicenterClient({
			baseURL,
			ownerId: asOwnerId('owner-1'),
			fetch: async (input) => {
				ticketCalls.push(String(input));
				return new Response('unauthorized', { status: 401 });
			},
		});

		const { data, error } = await client.blobs.add(
			new Blob([new Uint8Array([1, 2, 3])], { type: 'text/plain' }),
		);

		expect(data).toBeNull();
		expect(error?.name).toBe('RequestFailed');
		if (error?.name === 'RequestFailed') {
			expect(error.status).toBe(401);
		}
		expect(putReached).toBe(false);
		expect(ticketCalls).toHaveLength(1);
	});
});
