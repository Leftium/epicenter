/**
 * Reactive auth-gated payload.
 *
 * Listens to `auth.state` and builds the app payload on sign-in, disposes
 * on sign-out. Same-user `reauth-required` is a no-op so the payload stays
 * mounted across credential refreshes.
 *
 * OAuth session storage is single-user by structure (one monolithic
 * `OAuthSession` blob; refresh tokens are user-scoped at issuance), so the
 * lifecycle treats two consecutive identity-bearing states as the same user
 * and does not re-check.
 *
 * The framework owns the lifecycle; apps own the payload shape. The build
 * function returns whatever shape the app wants (it must be `Disposable`).
 * Apps typically alias `session.require` to a named export
 * (`export const requireFuji = session.require`) for a one-line presence
 * assertion in descendants.
 *
 * Requires an `AuthClient` whose `state` is Svelte-reactive (use
 * `@epicenter/auth-svelte`, not `@epicenter/auth` directly).
 *
 * @example
 * ```ts
 * export const session = createSession({
 *   auth,
 *   build: (identity) => openFujiBrowser({
 *     userId: identity.user.id,
 *     encryptionKeys: () => requireIdentity(auth).encryptionKeys,
 *     ...
 *   }),
 * });
 *
 * export const requireFuji = session.require;
 * ```
 */

import type { AuthClient, AuthState, WorkspaceIdentity } from '@epicenter/auth';

export function createSession<T extends Disposable>({
	auth,
	build,
}: {
	auth: AuthClient;
	build: (identity: WorkspaceIdentity) => T;
}) {
	let payload = $state<T | null>(null);

	function reconcile(state: AuthState) {
		if (state.status === 'signed-out') {
			payload?.[Symbol.dispose]();
			payload = null;
		} else {
			payload ??= build(state.identity);
		}
	}

	const unsubscribe = auth.onStateChange(reconcile);
	reconcile(auth.state);

	return {
		get current(): T | null {
			return payload;
		},
		require(): T {
			if (!payload) {
				throw new Error(
					'[session] require() called without a payload. ' +
						'A descendant likely mounted outside the signed-in gate.',
				);
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
