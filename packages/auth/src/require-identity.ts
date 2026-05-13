import type { AuthClient } from './auth-contract.js';
import type { WorkspaceIdentity } from './auth-types.js';

/**
 * Read the current identity, throwing only when auth is fully signed-out.
 *
 * Both `signed-in` and `reauth-required` carry identity. Workspace-side code
 * that derived its lifecycle from identity-presence (encryption keys, user id,
 * lazy callbacks attached to a built workspace) keeps working across a
 * `reauth-required` transition; this helper reflects that invariant.
 *
 * Use inside lazy callbacks (e.g. `encryptionKeys: () => requireIdentity(auth).encryptionKeys`)
 * where the workspace has already proven, via the session lifecycle, that it
 * can only be alive while an identity is present. The throw is a type-system
 * honesty check: if it fires, the caller outlived its identity-bearing scope,
 * which is a caller bug.
 */
export function requireIdentity(auth: AuthClient): WorkspaceIdentity {
	if (auth.state.status === 'signed-out') {
		throw new Error('[auth] called requireIdentity while signed-out.');
	}
	return auth.state.identity;
}
