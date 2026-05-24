/**
 * Ownership boundary tests.
 *
 * The middleware closes `(mode, URL :ownerId, auth user)` into a resolved
 * `c.var.ownerId`. These tests pin the execution invariants:
 *
 *   - personal mode: URL `:ownerId` MUST equal `c.var.user.id`.
 *   - team mode: URL `:ownerId` MUST equal `TEAM_OWNER_ID`. (Pre-collapse
 *     the URL was decorative and any value silently resolved to the team
 *     partition; this test pins that we now reject mismatches.)
 *   - both modes: routes without `:ownerId` (the session endpoint) still
 *     attach the partition.
 *
 * Mount the middleware on patterns that include `:ownerId` (mirroring
 * `apps/api/src/index.ts`): Hono only populates route params for handlers
 * mounted at the matching pattern, so middleware mounted at `*` never
 * sees them.
 */

import { describe, expect, test } from 'bun:test';
import { type AuthUser, asUserId } from '@epicenter/auth';
import { TEAM_OWNER_ID } from '@epicenter/constants/identity';
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { createRequireOwnership } from './require-ownership.js';

function createTestApp(mode: 'personal' | 'team', userId: string) {
	const app = new Hono<Env>();
	const user = {
		id: asUserId(userId),
		email: `${userId}@x`,
	} satisfies AuthUser;
	app.use('*', async (c, next) => {
		c.set('user', user);
		await next();
	});
	const requireOwnership = createRequireOwnership(mode);
	app.use('/api/owners/:ownerId/*', requireOwnership);
	app.use('/api/session', requireOwnership);
	app.get('/api/owners/:ownerId/rooms/:roomId', (c) => c.text(c.var.ownerId));
	app.get('/api/session', (c) => c.text(c.var.ownerId));
	return app;
}

describe('personal mode', () => {
	test('attaches user.id as ownerId when URL :ownerId matches', async () => {
		const res = await createTestApp('personal', 'alice').request(
			'/api/owners/alice/rooms/r1',
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('alice');
	});

	test('rejects URL :ownerId mismatch with 403 OwnerMismatch', async () => {
		const res = await createTestApp('personal', 'alice').request(
			'/api/owners/bob/rooms/r1',
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('OwnerMismatch');
	});

	test('rejects URL :ownerId set to the team sentinel', async () => {
		const res = await createTestApp('personal', 'alice').request(
			'/api/owners/team/rooms/r1',
		);
		expect(res.status).toBe(403);
	});

	test('routes without :ownerId attach user.id and pass through', async () => {
		const res = await createTestApp('personal', 'alice').request(
			'/api/session',
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('alice');
	});
});

describe('team mode', () => {
	test('attaches TEAM_OWNER_ID when URL :ownerId is the team sentinel', async () => {
		const res = await createTestApp('team', 'alice').request(
			'/api/owners/team/rooms/r1',
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(TEAM_OWNER_ID);
	});

	test('REJECTS URL :ownerId set to a user id (pre-collapse silent bypass)', async () => {
		const res = await createTestApp('team', 'alice').request(
			'/api/owners/alice/rooms/r1',
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('OwnerMismatch');
	});

	test('REJECTS arbitrary URL :ownerId values', async () => {
		const res = await createTestApp('team', 'alice').request(
			'/api/owners/anything/rooms/r1',
		);
		expect(res.status).toBe(403);
	});

	test('routes without :ownerId attach TEAM_OWNER_ID', async () => {
		const res = await createTestApp('team', 'alice').request('/api/session');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(TEAM_OWNER_ID);
	});
});
