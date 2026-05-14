import {
	type AuthClient,
	type AuthState,
	requireIdentity,
} from '@epicenter/auth';
import { createLocalOwner, type LocalOwner } from '@epicenter/workspace';

/**
 * Auth-gated payload built once per identity-bearing auth state and disposed
 * on sign-out. `reauth-required` keeps the existing payload mounted: OAuth
 * sessions are single-user by structure, so two consecutive identity-bearing
 * states are always the same user.
 *
 * The build callback receives a `LocalOwner` (`@epicenter/workspace`) that
 * carries `userId` plus a lazy `encryptionKeys()` reader. Apps forward `owner`
 * to their browser bundle and call `owner.attachEncryption(ydoc)`,
 * `owner.attachIndexedDb(ydoc)`, etc., instead of threading `userId` and
 * `encryptionKeys` separately.
 *
 * Requires an `AuthClient` whose `state` is Svelte-reactive (use
 * `@epicenter/auth-svelte`, not `@epicenter/auth` directly).
 */
export function createSession<T extends Disposable>({
	auth,
	build,
}: {
	auth: AuthClient;
	build: (context: { owner: LocalOwner }) => T;
}) {
	let payload = $state<T | null>(null);

	function reconcile(state: AuthState) {
		if (state.status === 'signed-out') {
			payload?.[Symbol.dispose]();
			payload = null;
			return;
		}
		if (payload) return;
		payload = build({
			owner: createLocalOwner({
				userId: state.identity.user.id,
				encryptionKeys: () => requireIdentity(auth).encryptionKeys,
			}),
		});
	}

	const unsubscribe = auth.onStateChange(reconcile);
	reconcile(auth.state);

	return {
		get current(): T | null {
			return payload;
		},
		require(): T {
			if (!payload) {
				throw new Error('[session] require() called while signed-out.');
			}
			return payload;
		},
		[Symbol.dispose]() {
			unsubscribe();
			payload?.[Symbol.dispose]();
			payload = null;
		},
	};
}
