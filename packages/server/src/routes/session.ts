/**
 * `/api/session` sub-app.
 *
 * Returns the authenticated user, their owner identity (the partition this
 * request resolves through), and the per-owner workspace keyring. Clients
 * cache the response so workspace boot, local-storage keying, and Yjs
 * decryption work offline.
 *
 * The keyring is derived from the owner's partition label via the
 * deployment's root keyring (lives in `ENCRYPTION_SECRETS`). Personal owners
 * get a user-scoped subject; team owners share one team-scoped subject.
 */

import type { ApiSessionResponse } from '@epicenter/auth';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { deriveSubjectKeyring } from '../auth/encryption.js';
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
			// Subject label: in personal mode this is the user's id (byte-
			// identical to the pre-split derivation, so existing keyrings stay
			// valid); in team mode it is the literal `team`, shared across the
			// deployment.
			const subject =
				opts.ownerKind === 'personal' ? c.var.user.id : 'team';
			const keyring = await deriveSubjectKeyring(subject);
			return c.json({
				user: c.var.user,
				localIdentity: { subject, keyring },
			} satisfies ApiSessionResponse);
		},
	);
}
