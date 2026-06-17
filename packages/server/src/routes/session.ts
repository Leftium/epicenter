/**
 * `/api/session` sub-app.
 *
 * Returns the authenticated user and the `ownerId` the request resolves
 * through. Clients cache the response so workspace boot and local-storage
 * keying work offline.
 *
 * {@link mountSessionApp} wires cookie-or-bearer auth and the ownership
 * boundary so `c.var.user` and `c.var.ownerId` are populated before the
 * handler runs. The handler stays mode-blind. Deployment shape is not on
 * the wire; it is a property of the server (see `OwnerId` in
 * `@epicenter/identity`).
 */

import type { ApiSessionResponse } from '@epicenter/auth';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { requireCookieOrBearerUser } from '../middleware/require-auth.js';
import { createRequireOwnership } from '../middleware/require-ownership.js';
import type { OwnershipRule } from '../ownership.js';
import type { Env } from '../types.js';

const sessionApp = new Hono<Env>().get(
	API_ROUTES.session.pattern,
	describeRoute({
		description: 'Return the authenticated session projection',
		tags: ['auth'],
	}),
	async (c) => {
		const ownerId = c.var.ownerId;
		return c.json({
			user: { id: c.var.user.id, email: c.var.user.email },
			ownerId,
		} satisfies ApiSessionResponse);
	},
);

/**
 * Mount the session surface on a deployment's server app.
 *
 * Bundles cookie-or-bearer auth (the session endpoint is reachable from
 * both browser apps and API clients), the ownership boundary (no URL
 * `:ownerId` to compare against, but shared-mode admission is still
 * enforced and `c.var.ownerId` is populated), and the route mount into
 * one call.
 */
export function mountSessionApp(
	app: Hono<Env>,
	opts: { ownership: OwnershipRule },
): void {
	app.use(
		API_ROUTES.session.pattern,
		requireCookieOrBearerUser,
		createRequireOwnership(opts.ownership),
	);
	app.route('/', sessionApp);
}
