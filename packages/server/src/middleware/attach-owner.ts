import { asOwnerId, TEAM_OWNER_ID } from '@epicenter/auth';
import { createMiddleware } from 'hono/factory';
import type { Env, OwnershipMode } from '../types.js';

/**
 * Build the `attachOwner` middleware for a deployment.
 *
 * Resolves the request's owner partition once, from `(mode, c.var.user.id)`,
 * and stashes it on `c.var.ownerId`. Handlers downstream read `c.var.ownerId`
 * directly and stay mode-blind.
 *
 * The URL `:ownerId` segment carries no information this resolver doesn't
 * already have: personal mode is gated by `requireUrlOwnerIdMatchesAuth`
 * (`:ownerId === user.id`), and team mode pins `:ownerId` to the literal
 * `TEAM_OWNER_ID` at the route pattern. Reading the URL param in handlers
 * would be a trust-chain lie; this middleware owns the resolution rule
 * instead.
 *
 * Mount AFTER the middleware that populates `c.var.user`. Forgetting the
 * mount on a route that reads `c.var.ownerId` surfaces as a typecheck
 * failure on the missing variable.
 */
export function createAttachOwner(mode: OwnershipMode) {
	const isPersonal = mode === 'personal';
	return createMiddleware<Env>(async (c, next) => {
		c.set('ownerId', isPersonal ? asOwnerId(c.var.user.id) : TEAM_OWNER_ID);
		await next();
	});
}
