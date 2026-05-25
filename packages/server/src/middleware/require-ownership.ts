/**
 * Deployment ownership boundary.
 *
 * One middleware that closes the matrix `(rule, URL :ownerId, auth user)`
 * into a resolved owner partition on `c.var.ownerId`:
 *
 *   1. Resolve the expected partition from `(rule, c.var.user)` via
 *      {@link resolveExpectedOwnerId}. In team mode this also runs the
 *      deployment's membership predicate; non-members get 403
 *      NotTeamMember before any URL is read.
 *   2. If the route declares `:ownerId`, assert the URL segment equals
 *      the expected partition. Mismatch is 403 OwnerMismatch in both
 *      modes.
 *   3. Routes without `:ownerId` (the session endpoint) skip the URL
 *      check; the partition still resolves and attaches.
 *
 * Mount AFTER the auth middleware so `c.var.user` is populated.
 * Forgetting the mount on a route that reads `c.var.ownerId` surfaces as
 * a typecheck failure on the missing variable.
 */

import { RequestGuardError } from '@epicenter/constants/request-guard-errors';
import { createMiddleware } from 'hono/factory';
import { type OwnershipRule, resolveExpectedOwnerId } from '../ownership.js';
import type { Env } from '../types.js';

export function createRequireOwnership(rule: OwnershipRule) {
	return createMiddleware<Env>(async (c, next) => {
		const { data: expectedOwnerId, error } = await resolveExpectedOwnerId(
			rule,
			c,
		);
		if (error) return c.json(error, 403);
		const urlOwnerId = c.req.param('ownerId');
		if (urlOwnerId !== undefined && urlOwnerId !== expectedOwnerId) {
			return c.json(RequestGuardError.OwnerMismatch(), 403);
		}
		c.set('ownerId', expectedOwnerId);
		await next();
	});
}
