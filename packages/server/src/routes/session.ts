/**
 * `/api/session` sub-app.
 *
 * Returns the authenticated user, the owner the request resolves through
 * (`{ kind: 'personal', userId } | { kind: 'team' }`), and the per-owner
 * workspace keyring. Clients cache the response so workspace boot,
 * local-storage keying, and Yjs decryption work offline.
 *
 * The keyring is derived from a per-owner HKDF label via the deployment's
 * root keyring (`ENCRYPTION_SECRETS`). Personal owners get a per-user
 * keyring; every member of a team deployment shares one keyring.
 */

import type { ApiSessionResponse, Owner } from '@epicenter/auth';
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
			const owner: Owner =
				opts.ownerKind === 'personal'
					? { kind: 'personal', userId: c.var.user.id }
					: { kind: 'team' };
			// HKDF label: personal mode uses the bare user id (byte-pinned to
			// the pre-split derivation, so any existing keyring stays valid);
			// team mode uses the empty string, matching `ownerPath(team) === ''`
			// and keeping `kind: 'team'` as the sole place the word `team`
			// appears as a value. Domain separation across deployments comes
			// from each deployment's `ENCRYPTION_SECRETS`, not from this label.
			// Not routed through an Owner-aware helper on purpose: the bytes
			// are the contract, and a helper would invite drift.
			const hkdfLabel = owner.kind === 'personal' ? owner.userId : '';
			const keyring = await deriveSubjectKeyring(hkdfLabel);
			return c.json({
				user: c.var.user,
				owner,
				keyring,
			} satisfies ApiSessionResponse);
		},
	);
}
