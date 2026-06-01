/**
 * Ownership boundary tests.
 *
 * The middleware closes `(rule, URL :ownerId, auth user)` into a resolved
 * `c.var.ownerId`. These tests pin the execution invariants for both
 * variants of `OwnershipRule`:
 *
 *   - personal: URL `:ownerId` MUST equal `c.var.user.id`.
 *   - shared:   the admit predicate MUST admit the user, AND
 *               URL `:ownerId` MUST equal `SHARED_OWNER_ID`.
 *
 * Mount the middleware on patterns that include `:ownerId` (mirroring
 * `apps/api/src/index.ts`): Hono only populates route params for handlers
 * mounted at the matching pattern, so middleware mounted at `*` never
 * sees them.
 */

import { describe, expect, test } from 'bun:test';
import { type AuthUser, asUserId } from '@epicenter/auth';
import { SHARED_OWNER_ID } from '@epicenter/identity';
import { Hono } from 'hono';
import { type OwnershipRule, personal, shared } from '../ownership.js';
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

	test('rejects URL :ownerId set to the shared sentinel', async () => {
		const res = await createTestApp(personal(), 'alice').request(
			'/api/owners/shared/rooms/r1',
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

describe('shared({ admit })', () => {
	const admitAll = shared({ admit: () => true });
	const admitNone = shared({ admit: () => false });
	const admitAcme = shared({
		admit: (c) => c.var.user.email.endsWith('@acme.com'),
	});

	test('attaches SHARED_OWNER_ID when admitted + URL is shared sentinel', async () => {
		const res = await createTestApp(admitAll, 'alice').request(
			'/api/owners/shared/rooms/r1',
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(SHARED_OWNER_ID);
	});

	test('REJECTS URL :ownerId set to a user id (silent-bypass guard)', async () => {
		const res = await createTestApp(admitAll, 'alice').request(
			'/api/owners/alice/rooms/r1',
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('OwnerMismatch');
	});

	test('REJECTS arbitrary URL :ownerId values', async () => {
		const res = await createTestApp(admitAll, 'alice').request(
			'/api/owners/anything/rooms/r1',
		);
		expect(res.status).toBe(403);
	});

	test('routes without :ownerId attach SHARED_OWNER_ID for admitted users', async () => {
		const res = await createTestApp(admitAll, 'alice').request('/api/session');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(SHARED_OWNER_ID);
	});

	test('rejected user gets 403 NotAdmitted before any URL check', async () => {
		const res = await createTestApp(admitNone, 'alice').request(
			'/api/owners/shared/rooms/r1',
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('NotAdmitted');
	});

	test('rejected user denied on session route too (no :ownerId required)', async () => {
		const res = await createTestApp(admitNone, 'alice').request('/api/session');
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('NotAdmitted');
	});

	test('email-domain predicate admits matching user', async () => {
		const app = (() => {
			const a = new Hono<Env>();
			const user = {
				id: asUserId('alice'),
				email: 'alice@acme.com',
			} satisfies AuthUser;
			a.use('*', async (c, next) => {
				c.set('user', user);
				await next();
			});
			a.use('/api/owners/:ownerId/*', createRequireOwnership(admitAcme));
			a.get('/api/owners/:ownerId/rooms/:roomId', (c) => c.text(c.var.ownerId));
			return a;
		})();
		const res = await app.request('/api/owners/shared/rooms/r1');
		expect(res.status).toBe(200);
	});

	test('email-domain predicate rejects non-matching user', async () => {
		const app = (() => {
			const a = new Hono<Env>();
			const user = {
				id: asUserId('mallory'),
				email: 'mallory@evilcorp.com',
			} satisfies AuthUser;
			a.use('*', async (c, next) => {
				c.set('user', user);
				await next();
			});
			a.use('/api/owners/:ownerId/*', createRequireOwnership(admitAcme));
			a.get('/api/owners/:ownerId/rooms/:roomId', (c) => c.text(c.var.ownerId));
			return a;
		})();
		const res = await app.request('/api/owners/shared/rooms/r1');
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { name: string } };
		expect(body.error.name).toBe('NotAdmitted');
	});
});
