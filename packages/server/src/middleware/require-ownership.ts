/**
 * Deployment ownership boundary.
 *
 * One middleware that closes the matrix `(mode, URL :ownerId, auth user)`
 * into a resolved owner partition on `c.var.ownerId`:
 *
 *   1. Compute the expected partition from `(mode, c.var.user.id)`.
 *      Personal: the signed-in user's id (a UserId, byte-equal to an
 *      OwnerId). Team: the literal `TEAM_OWNER_ID`.
 *   2. If the route declares `:ownerId`, assert the URL segment equals
 *      the expected partition. Mismatch is a 403 in both modes. Team mode
 *      used to silently overwrite the URL — now the URL is honest.
 *   3. Routes without `:ownerId` (the session endpoint) skip the URL
 *      check; the partition still resolves and attaches.
 *
 * Mount AFTER the auth middleware so `c.var.user` is populated.
 * Forgetting the mount on a route that reads `c.var.ownerId` surfaces as
 * a typecheck failure on the missing variable.
 */

import {
	asOwnerId,
	type OwnerId,
	TEAM_OWNER_ID,
} from '@epicenter/constants/identity';
import { RequestGuardError } from '@epicenter/constants/request-guard-errors';
import { createMiddleware } from 'hono/factory';
import type { Env, OwnershipMode } from '../types.js';

/**
 * The single rule for "what partition does this signed-in actor map to in
 * this deployment?" Personal collapses to the actor's id (byte-equal to
 * the OwnerId); team collapses to the fixed sentinel. Exported so the
 * conditional asset GET (which runs auth inline and cannot use the
 * middleware) goes through the same rule.
 */
export function resolveExpectedOwnerId(
	mode: OwnershipMode,
	userId: string,
): OwnerId {
	return mode === 'personal' ? asOwnerId(userId) : TEAM_OWNER_ID;
}

export function createRequireOwnership(mode: OwnershipMode) {
	return createMiddleware<Env>(async (c, next) => {
		const expectedOwnerId = resolveExpectedOwnerId(mode, c.var.user.id);
		const urlOwnerId = c.req.param('ownerId');
		if (urlOwnerId !== undefined && urlOwnerId !== expectedOwnerId) {
			return c.json(RequestGuardError.OwnerMismatch(), 403);
		}
		c.set('ownerId', expectedOwnerId);
		await next();
	});
}
