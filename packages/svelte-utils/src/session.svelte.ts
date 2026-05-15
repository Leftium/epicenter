import type { AuthClient, AuthState } from '@epicenter/auth';
import { createLocalOwner, type LocalOwner } from '@epicenter/workspace';

/**
 * Auth-gated payload built once per identity-bearing auth state and disposed
 * on sign-out. `reauth-required` keeps the existing payload mounted: OAuth
 * sessions are single-user by structure, so two consecutive identity-bearing
 * states are always the same user.
 *
 * The build callback receives a `LocalOwner` (`@epicenter/workspace`) that
 * carries `userId` plus a lazy `encryptionKeys()` reader. The reader pulls
 * from the live `state.unlock` so refreshed encryption keys (after `/api/me`
 * adjusts them) are picked up on next access without rebuilding the payload.
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
				userId: state.unlock.userId,
				encryptionKeys: () => {
					if (auth.state.status === 'signed-out') {
						throw new Error(
							'[session] encryptionKeys() called while signed-out.',
						);
					}
					return auth.state.unlock.encryptionKeys;
				},
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
