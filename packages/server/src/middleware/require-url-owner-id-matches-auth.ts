/**
 * Personal-mode safety gate.
 *
 * Personal routes carry the authenticated owner's id in the URL
 * (`/api/owners/:ownerId/...`) so handlers can compute the partition prefix
 * without a DB lookup. In personal mode `ownerId === userId`, so this gate
 * compares the URL's `:ownerId` against `c.var.user.id` and rejects mismatches
 * with 403. The id is not a credential, but a malicious caller with their own
 * session could otherwise reach `/api/owners/alice/...` while signed in as Bob.
 *
 * Mount AFTER the auth middleware so `c.var.user` is populated. Team mode
 * does not mount this gate: `:ownerId` is the literal `'team'` and no
 * per-user check applies.
 */

import { createMiddleware } from 'hono/factory';
import type { Env } from '../types.js';

export const requireUrlOwnerIdMatchesAuth = createMiddleware<Env>(
	async (c, next) => {
		const urlOwnerId = c.req.param('ownerId');
		if (!urlOwnerId || urlOwnerId !== c.var.user.id) {
			return c.json({ name: 'forbidden_owner_mismatch' }, 403);
		}
		await next();
	},
);
