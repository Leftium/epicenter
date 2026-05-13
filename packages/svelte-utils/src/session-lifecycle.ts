import type { AuthClient, AuthState, WorkspaceIdentity } from '@epicenter/auth';
import type { AppBase, SessionPayload } from './session.svelte.js';

export type SessionLifecycleConfig<TApp extends AppBase> = {
	auth: AuthClient;
	build: (identity: WorkspaceIdentity) => TApp;
	getPayload: () => SessionPayload<TApp> | null;
	setPayload: (payload: SessionPayload<TApp> | null) => void;
	onDifferentUser: () => void;
};

/**
 * Pure lifecycle for the session payload. Owns the build/dispose contract
 * and the user-switch refusal. Reactivity (`$state`) is injected through
 * `getPayload`/`setPayload` so this helper can be tested without Svelte.
 *
 * Disposal triggers:
 *   - `state.status === 'signed-out'` → dispose, set null
 *   - same payload, different `user.id` → dispose, call `onDifferentUser`
 *
 * Same-user `reauth-required` is a no-op: the existing `SessionPayload`
 * object is preserved, so consumer references stay stable across the auth
 * state transition.
 */
export function createSessionLifecycle<TApp extends AppBase>({
	auth,
	build,
	getPayload,
	setPayload,
	onDifferentUser,
}: SessionLifecycleConfig<TApp>) {
	function reconcile(state: AuthState) {
		const payload = getPayload();
		if (state.status === 'signed-out') {
			if (payload) {
				payload.app[Symbol.dispose]();
				setPayload(null);
			}
			return;
		}
		// signed-in or reauth-required: both carry identity.
		if (!payload) {
			const app = build(state.identity);
			setPayload({ identity: state.identity, app });
			return;
		}
		// Same user: no-op. The payload reference stays stable across
		// signed-in <-> reauth-required transitions so consumers keep their
		// references. Auth-bound callbacks read `auth.state` at their own
		// boundaries (sync at reconnect, fetch at next call).
		if (payload.app.userId === state.identity.user.id) return;
		// Different user: refuse the live switch and reload (heap safety).
		payload.app[Symbol.dispose]();
		setPayload(null);
		onDifferentUser();
	}

	const unsubscribe = auth.onStateChange(reconcile);
	// Initial replay: auth may have already settled before subscribe ran.
	reconcile(auth.state);

	return {
		[Symbol.dispose]() {
			unsubscribe();
			getPayload()?.app[Symbol.dispose]();
			setPayload(null);
		},
	};
}
