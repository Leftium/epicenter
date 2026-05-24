/**
 * `/api/session` sub-app.
 *
 * Returns the authenticated user, the `ownerId` the request resolves
 * through, and the per-owner workspace keyring. Clients cache the response
 * so workspace boot, local-storage keying, and Yjs decryption work offline.
 *
 * The keyring is derived from a per-owner HKDF label via the deployment's
 * root keyring (`ENCRYPTION_SECRETS`). The label IS the `ownerId`: personal
 * owners get a per-user keyring (`ownerId === userId`); every member of a
 * team deployment shares one keyring (`ownerId === TEAM_OWNER_ID`).
 *
 * The owner partition is resolved by the `attachOwner` middleware, not by
 * this handler. The handler reads `c.var.ownerId` and stays mode-blind.
 * Deployment shape is not on the wire: any consumer that needs to branch
 * derives it from `ownerId === TEAM_OWNER_ID`.
 */

import type { ApiSessionResponse } from '@epicenter/auth';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { deriveKeyring } from '../auth/encryption.js';
import { createAttachOwner } from '../middleware/attach-owner.js';
import { requireCookieOrBearerUser } from '../middleware/require-auth.js';
import type { Env, ServerOptions } from '../types.js';

export function createSessionApp(opts: ServerOptions): Hono<Env> {
	const attachOwner = createAttachOwner(opts.mode);
	return new Hono<Env>().get(
		'/',
		describeRoute({
			description: 'Return the authenticated session projection',
			tags: ['auth'],
		}),
		requireCookieOrBearerUser,
		attachOwner,
		async (c) => {
			const ownerId = c.var.ownerId;
			const keyring = await deriveKeyring(ownerId);
			return c.json({
				user: { id: c.var.user.id, email: c.var.user.email },
				ownerId,
				keyring,
			} satisfies ApiSessionResponse);
		},
	);
}
