/**
 * `/api/session` sub-app.
 *
 * Returns the authenticated user, the `ownerId` the request resolves through,
 * the per-owner workspace keyring, and the deployment `mode`. Clients cache
 * the response so workspace boot, local-storage keying, and Yjs decryption
 * work offline.
 *
 * The keyring is derived from a per-owner HKDF label via the deployment's
 * root keyring (`ENCRYPTION_SECRETS`). The label IS the `ownerId`: personal
 * owners get a per-user keyring (`ownerId === userId`); every member of a
 * team deployment shares one keyring (`ownerId === 'team'`).
 */

import {
	type ApiSessionResponse,
	asOwnerId,
	asUserId,
} from '@epicenter/auth';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { deriveKeyring } from '../auth/encryption.js';
import { requireCookieOrBearerUser } from '../middleware/require-auth.js';
import type { Env, ServerOptions } from '../types.js';

export function createSessionApp(opts: ServerOptions): Hono<Env> {
	return new Hono<Env>().get(
		'/',
		describeRoute({
			description: 'Return the authenticated session projection',
			tags: ['auth'],
		}),
		requireCookieOrBearerUser,
		async (c) => {
			// `ownerId` IS the HKDF label. In personal mode the bytes equal
			// the signed-in user's id; in team mode the bytes are the literal
			// `'team'`. Both shapes were the HKDF label before the collapse,
			// so existing keyrings keep decrypting. Domain separation across
			// deployments comes from each deployment's `ENCRYPTION_SECRETS`.
			const ownerId =
				opts.mode === 'personal'
					? asOwnerId(c.var.user.id)
					: asOwnerId('team');
			const keyring = await deriveKeyring(ownerId);
			return c.json({
				user: { id: asUserId(c.var.user.id), email: c.var.user.email },
				ownerId,
				keyring,
				mode: opts.mode,
			} satisfies ApiSessionResponse);
		},
	);
}
