/**
 * Ownership boundary tests.
 *
 * The middleware closes `(rule, URL :ownerId, auth user)` into a resolved
 * `c.var.ownerId`. These tests pin the execution invariants for both
 * variants of `OwnershipRule`:
 *
 *   - personal: URL `:ownerId` MUST equal `c.var.user.id`.
 *   - instance: URL `:ownerId` MUST equal `INSTANCE_OWNER_ID`, regardless of
 *               caller identity (the partition is pinned to a constant).
 *
 * Mount the middleware on patterns that include `:ownerId` (mirroring
 * `apps/api/worker/index.ts`): Hono only populates route params for handlers
 * mounted at the matching pattern, so middleware mounted at `*` never
 * sees them.
 */

import { describe, expect, test } from 'bun:test';
import { type AuthUser, asUserId } from '@epicenter/auth';
import { INSTANCE_OWNER_ID } from '@epicenter/identity';
import { Hono } from 'hono';
import { instance, type OwnershipRule, personal } from '../ownership.js';
import type { Env } from '../types.js';
import { createRequireOwnership } from './require-ownership.js';

function createTestApp(rule: OwnershipRule, userId: string) {
	const app = new Hono<Env>();
	const user = {
		id: asUserId(userId),
		email: `${userId}@x`,
	} satisfies AuthUser;
	app.use('*', async (c, next) => {
		c.set('user', user);
		await next();
	});
	const requireOwnership = createRequireOwnership(rule);
	app.use('/api/owners/:ownerId/*', requireOwnership);
	app.use('/api/session', requireOwnership);
	app.get('/api/owners/:ownerId/rooms/:roomId', (c) => c.text(c.var.ownerId));
	app.get('/api/session', (c) => c.text(c.var.ownerId));
	return app;
}

describe('personal()', () => {
	test('attaches user.id as ownerId when URL :ownerId matches', async () => {
		const res = await createTestApp(personal(), 'alice').request(
			'/api/owners/alice/rooms/r1',
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('alice');
	});

	test('rejects URL :ownerId mismatch with 403 OwnerMismatch', async () => {
		const res = await createTestApp(personal(), 'alice').request(
			'/api/owners/bob/rooms/r1',
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('OwnerMismatch');
	});

	test('rejects URL :ownerId set to a foreign partition string', async () => {
		const res = await createTestApp(personal(), 'alice').request(
			'/api/owners/instance/rooms/r1',
		);
		expect(res.status).toBe(403);
	});

	test('routes without :ownerId attach user.id and pass through', async () => {
		const res = await createTestApp(personal(), 'alice').request(
			'/api/session',
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('alice');
	});
});

describe('instance()', () => {
	test('attaches INSTANCE_OWNER_ID under owners/instance', async () => {
		const res = await createTestApp(instance(), 'owner').request(
			'/api/owners/instance/rooms/r1',
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(INSTANCE_OWNER_ID);
	});

	test('pins the SAME partition regardless of caller identity', async () => {
		// The load-bearing invariant (ADR-0075): the partition is decoupled from
		// the principal, so two different principals resolve to one `owners/instance`
		// and a future per-person named token never re-partitions the box's data.
		// This is exactly what `personal()` + a fixed owner id would NOT give.
		for (const id of ['alice', 'bob', 'instance']) {
			const res = await createTestApp(instance(), id).request(
				'/api/owners/instance/rooms/r1',
			);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe(INSTANCE_OWNER_ID);
		}
	});

	test('REJECTS URL :ownerId set to a user id (silent-bypass guard)', async () => {
		const res = await createTestApp(instance(), 'owner').request(
			'/api/owners/owner/rooms/r1',
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('OwnerMismatch');
	});

	test('routes without :ownerId attach INSTANCE_OWNER_ID', async () => {
		const res = await createTestApp(instance(), 'owner').request(
			'/api/session',
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(INSTANCE_OWNER_ID);
	});
});
