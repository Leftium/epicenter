import type { AuthClient, AuthState } from '@epicenter/auth';
import { createLocalOwner, type LocalOwner } from '@epicenter/workspace';

/**
 * Auth-gated payload built once per identity-bearing auth state and disposed
 * on sign-out. `reauth-required` keeps the existing payload mounted: OAuth
 * sessions publish a signed-out gap before a different owner mounts, so two
 * consecutive identity-bearing states are always the same owner.
 *
 * The build callback receives a `LocalOwner` (`@epicenter/workspace`). The
 * owner is constructed with the auth client's `(server, owner)` pair so two
 * different deployments on the same machine never collide on browser-local
 * IndexedDB or BroadcastChannel names. `keyring()` is a lazy reader that
 * pulls from the live `state.keyring` so refreshed keyrings from
 * `/api/session` are picked up on next access without rebuilding the
 * payload.
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
	// `server` is constant across auth states (the client signs into one API
	// per construction). Compute once; reuse across every payload rebuild.
	const server = new URL(auth.baseURL).host;

	function reconcile(state: AuthState) {
		if (state.status === 'signed-out') {
			payload?.[Symbol.dispose]();
			payload = null;
			return;
		}
		if (payload) return;

		buildPayload(state);
	}

	function buildPayload(state: Exclude<AuthState, { status: 'signed-out' }>) {
		payload = build({
			owner: createLocalOwner({
				server,
				owner: state.owner,
				keyring: () => {
					if (auth.state.status === 'signed-out') {
						throw new Error('[session] keyring() called while signed-out.');
					}
					return auth.state.keyring;
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
