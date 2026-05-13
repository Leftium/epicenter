import type { AuthClient, AuthState, WorkspaceIdentity } from '@epicenter/auth';

export type SessionLifecycleConfig<T extends Disposable> = {
	auth: AuthClient;
	build: (identity: WorkspaceIdentity) => T;
	getPayload: () => T | null;
	setPayload: (payload: T | null) => void;
	onDifferentUser: () => void;
};

/**
 * Pure lifecycle for the session payload. Owns the build/dispose contract
 * and the user-switch refusal. Reactivity is injected via
 * `getPayload`/`setPayload` so this helper can be tested without Svelte.
 *
 * Disposal triggers:
 *   - `state.status === 'signed-out'` → dispose, set null
 *   - same-session different `user.id` → dispose, call `onDifferentUser`
 *
 * Same-user `reauth-required` is a no-op: the existing payload reference
 * stays stable so consumers keep their references. The lifecycle tracks
 * the built user id internally; the payload does NOT need to carry it.
 */
export function createSessionLifecycle<T extends Disposable>({
	auth,
	build,
	getPayload,
	setPayload,
	onDifferentUser,
}: SessionLifecycleConfig<T>) {
	let currentUserId: string | null = null;

	function reconcile(state: AuthState) {
		const payload = getPayload();
		if (state.status === 'signed-out') {
			if (payload) {
				payload[Symbol.dispose]();
				setPayload(null);
				currentUserId = null;
			}
			return;
		}
		// signed-in or reauth-required: both carry identity.
		if (!payload) {
			currentUserId = state.identity.user.id;
			setPayload(build(state.identity));
			return;
		}
		// Same user: no-op. The payload reference stays stable across
		// signed-in <-> reauth-required transitions so consumers keep their
		// references. Auth-bound callbacks read `auth.state` at their own
		// boundaries (sync at reconnect, fetch at next call).
		if (currentUserId === state.identity.user.id) return;
		// Different user: refuse the live switch (apps typically reload).
		payload[Symbol.dispose]();
		setPayload(null);
		currentUserId = null;
		onDifferentUser();
	}

	const unsubscribe = auth.onStateChange(reconcile);
	// Initial replay: auth may have already settled before subscribe ran.
	reconcile(auth.state);

	return {
		[Symbol.dispose]() {
			unsubscribe();
			getPayload()?.[Symbol.dispose]();
			setPayload(null);
			currentUserId = null;
		},
	};
}
