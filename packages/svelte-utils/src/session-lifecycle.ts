import type { AuthClient, AuthState, WorkspaceIdentity } from '@epicenter/auth';

export type SessionLifecycleConfig<T extends Disposable> = {
	auth: AuthClient;
	build: (identity: WorkspaceIdentity) => T;
	getPayload: () => T | null;
	setPayload: (payload: T | null) => void;
};

/**
 * Pure lifecycle for the session payload. Builds once per identity, disposes
 * on signed-out. Reactivity is injected via `getPayload`/`setPayload` so this
 * helper can be tested without Svelte.
 *
 * OAuth session storage is single-user by structure (one monolithic
 * `OAuthSession` blob; refresh tokens are user-scoped at issuance), so the
 * lifecycle treats two consecutive identity-bearing states as the same user
 * and does not re-check. Same-user `reauth-required` is therefore a no-op
 * and the payload reference stays stable across credential refreshes.
 */
export function createSessionLifecycle<T extends Disposable>({
	auth,
	build,
	getPayload,
	setPayload,
}: SessionLifecycleConfig<T>) {
	function reconcile(state: AuthState) {
		const payload = getPayload();
		if (state.status === 'signed-out') {
			if (payload) {
				payload[Symbol.dispose]();
				setPayload(null);
			}
			return;
		}
		if (!payload) setPayload(build(state.identity));
	}

	const unsubscribe = auth.onStateChange(reconcile);
	reconcile(auth.state);

	return {
		[Symbol.dispose]() {
			unsubscribe();
			getPayload()?.[Symbol.dispose]();
			setPayload(null);
		},
	};
}
