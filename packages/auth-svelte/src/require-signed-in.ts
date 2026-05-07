import type { AuthIdentity } from '@epicenter/auth';
import type { AuthClient } from './create-auth.svelte.ts';

/**
 * Read the current identity, throwing if auth is not signed-in.
 *
 * Use inside lazy callbacks (e.g. `encryptionKeys: () => requireSignedIn(auth).encryptionKeys`)
 * where the workspace has already proven, via the session lifecycle, that it
 * can only be alive while signed-in. The throw is a type-system honesty check:
 * if it ever fires, the workspace outlived its signed-in scope, which is a
 * caller bug.
 */
export function requireSignedIn(auth: AuthClient): AuthIdentity {
	if (auth.state.status !== 'signed-in') {
		throw new Error('[auth] called requireSignedIn while not signed-in.');
	}
	return auth.state.identity;
}
