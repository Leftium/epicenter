import { ROOM_ROUTE } from '@epicenter/sync';
import { asOwnerId } from '@epicenter/identity';
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

/**
 * Regression: prove the real client/server URL contract.
 *
 * The client builds request URLs with `ROOM_ROUTE.url(...)` and the
 * server registers `ROOM_ROUTE.pattern`. This test wires both ends to the
 * same source of truth so a future change to the pattern or builder can't let
 * them drift apart. It also pins that dotted, composed child-doc guids survive
 * Hono route matching (Hono treats `.` as a literal, so a single `:roomId`
 * param captures the whole id).
 */
describe('rooms route pattern', () => {
	test('room url() round-trips through the route pattern for workspace and child-doc guids', async () => {
		const app = new Hono().get(ROOM_ROUTE.pattern, (c) =>
			c.json({
				ownerId: c.req.param('ownerId'),
				roomId: c.req.param('roomId'),
			}),
		);

		const ownerId = asOwnerId('user-1');
		const guids = [
			// Hyphenated workspace root id.
			'epicenter-fuji',
			// Composed child-doc guid; dots separate structural segments.
			'epicenter-fuji.entries.k7x9m2p4q8.content',
		];

		for (const guid of guids) {
			const url = ROOM_ROUTE.url('https://x', ownerId, guid);
			const res = await app.request(url);

			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				ownerId: string;
				roomId: string;
			};
			expect(body.roomId).toBe(guid);
			expect(body.ownerId).toBe('user-1');
		}
	});
});
