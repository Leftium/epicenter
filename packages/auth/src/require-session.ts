import type { AuthClient } from './auth-contract.js';
import type { WorkspaceIdentity } from './auth-types.js';
import { requireIdentity } from './require-identity.js';

/**
 * A convenience bundle of the active user's identity plus the transport
 * methods bound to their session. Use at call sites that need both pieces
 * (daemons, scripts) so a single local stands in for the identity AND the
 * transport, instead of mixing `requireIdentity(auth).encryptionKeys` with
 * `auth.openWebSocket`.
 *
 * For sites that need only one of the two (a single `auth.fetch` call, or
 * a UI component reading `user.email`), prefer `auth.fetch` /
 * `auth.state.identity` directly. `Session` is sugar for the multi-use
 * case, not a replacement.
 */
export type Session = WorkspaceIdentity & {
	fetch: AuthClient['fetch'];
	openWebSocket: AuthClient['openWebSocket'];
};

/**
 * Build a `Session` bundle from the current auth state. Throws if signed-out,
 * matching `requireIdentity`'s contract.
 */
export function requireSession(auth: AuthClient): Session {
	const identity = requireIdentity(auth);
	return {
		user: identity.user,
		encryptionKeys: identity.encryptionKeys,
		fetch: auth.fetch,
		openWebSocket: auth.openWebSocket,
	};
}
