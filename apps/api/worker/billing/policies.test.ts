/**
 * Storage policy accounting tests.
 *
 * Pins the no-overcharge contract of `trackAssetStorageWithAutumn`: a reserved
 * lock is committed (`confirm`) only on a successful upload and rolled back
 * (`release`) on any non-201, and a guard failure answers with the structured
 * billing envelope without reserving or calling the downstream handler. The
 * Autumn round-trips are mocked at the service boundary; this test owns only
 * the policy's HTTP orchestration.
 *
 * A worker crash between reserve and finalize is intentionally NOT exercised
 * here: that path is covered by Autumn's lock TTL auto-release, not by code in
 * this repo.
 */

import { AssetError } from '@epicenter/constants/asset-errors';
import type { Env } from '@epicenter/server';
import { beforeEach, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { Ok, type Result } from 'wellcrafted/result';

// `AssetError.StorageLimitExceeded(...)` already returns `Err<payload>`, so the
// Result's error type is that payload, not the `Err` wrapper.
type ReserveOutcome = Result<
	void,
	ReturnType<typeof AssetError.StorageLimitExceeded>['error']
>;

const finalizeCalls: Array<{ lockId: string; action: 'confirm' | 'release' }> = [];
const creditCalls: number[] = [];
let reserveOutcome: ReserveOutcome = Ok(undefined);

mock.module('./service.js', () => ({
	createBillingService: () => ({
		reserveAssetStorage: async (_input: { sizeBytes: number; lockId: string }) =>
			reserveOutcome,
		finalizeAssetStorage: (lockId: string, action: 'confirm' | 'release') => {
			finalizeCalls.push({ lockId, action });
			return Promise.resolve();
		},
		creditAssetStorage: (sizeBytes: number) => {
			creditCalls.push(sizeBytes);
			return Promise.resolve();
		},
	}),
}));

const { trackAssetStorageWithAutumn } = await import('./policies.js');

beforeEach(() => {
	finalizeCalls.length = 0;
	creditCalls.length = 0;
	reserveOutcome = Ok(undefined);
});

/** Mount the policy around a stub upload handler that returns `downstreamStatus`. */
function makeApp(downstreamStatus: 201 | 500 | 204) {
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('afterResponse', []);
		c.set('user', {
			id: 'user_1',
			email: 'user@example.com',
		} as Env['Variables']['user']);
		await next();
	});
	app.use('/assets', trackAssetStorageWithAutumn);
	app.post('/assets', (c) => c.body(null, downstreamStatus));
	app.delete('/assets', (c) => {
		c.header('x-deleted-size-bytes', '4096');
		return c.body(null, downstreamStatus);
	});
	return app;
}

function uploadForm() {
	const form = new FormData();
	form.set('file', new File([new Uint8Array(1024)], 'a.bin'));
	return form;
}

test('a successful upload (201) commits the reservation', async () => {
	const res = await makeApp(201).request('/assets', {
		method: 'POST',
		body: uploadForm(),
	});

	expect(res.status).toBe(201);
	expect(finalizeCalls).toHaveLength(1);
	expect(finalizeCalls[0]?.action).toBe('confirm');
});

test('a failed upload (500) releases the reservation, never charging', async () => {
	const res = await makeApp(500).request('/assets', {
		method: 'POST',
		body: uploadForm(),
	});

	expect(res.status).toBe(500);
	expect(finalizeCalls).toHaveLength(1);
	expect(finalizeCalls[0]?.action).toBe('release');
});

test('a guard rejection answers with the structured envelope and reserves nothing', async () => {
	reserveOutcome = AssetError.StorageLimitExceeded({ requestedBytes: 1024 });

	const res = await makeApp(201).request('/assets', {
		method: 'POST',
		body: uploadForm(),
	});

	expect(res.status).toBe(402);
	const body = (await res.json()) as { data: unknown; error: { name: string } };
	expect(body.data).toBeNull();
	expect(body.error.name).toBe('StorageLimitExceeded');
	// Reservation never committed and the upload handler never ran.
	expect(finalizeCalls).toHaveLength(0);
});

test('a delete (204) credits the freed bytes back', async () => {
	const res = await makeApp(204).request('/assets', { method: 'DELETE' });

	expect(res.status).toBe(204);
	expect(creditCalls).toEqual([4096]);
	expect(finalizeCalls).toHaveLength(0);
});
