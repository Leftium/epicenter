/**
 * Shared session state machine for apps that gate UI on an authenticated
 * identity plus an app-defined payload.
 *
 * `Session<T>` is the projection layer between `AuthState` and the app
 * binding. The shape is the discriminator: `SessionPayload<T> | null`. Apps
 * gate on truthiness (`if (session.current)`). The projection never surfaces
 * credential freshness; consumers that care about it read `auth.state.status`
 * directly.
 *
 * This factory owns the payload lifecycle (build, dispose) and the user-switch
 * refusal (different `user.id` disposes the payload and reloads the page).
 * Disposal is triggered ONLY by `signed-out` or a different `user.id`.
 * Same-user `reauth-required` is a no-op, so local app state stays mounted
 * while credentials refresh, and `session.current` keeps the same
 * `SessionPayload` reference across the transition.
 *
 * The returned `requireApp()` method is the standard descendant-side
 * assertion helper. Route layouts prove `session.current` before mounting
 * signed-in children; descendants call `requireApp()` once at script init
 * to assert they are inside that gated subtree. Re-export it from each app's
 * session module with `export const { requireApp } = session`.
 *
 * Lazy callbacks (e.g., `encryptionKeys`, `openWebSocket`) are read at:
 *   - attachment time (e.g., `attachEncryption` reads `encryptionKeys()` once
 *     per store registration to derive that store's keyring)
 *   - connection boundaries (`openWebSocket` is invoked at each sync
 *     connection attempt to attach a fresh bearer subprotocol)
 *
 * They are NOT read by already-attached encrypted stores. Same-user key
 * rotation does not propagate to stores whose keyring was derived at an
 * earlier registration; re-attach the store to derive a new keyring.
 *
 * Requires an `AuthClient` whose `state` is Svelte-reactive (use
 * `@epicenter/auth-svelte`, not `@epicenter/auth` directly).
 *
 * @example
 * ```ts
 * export const session = createSession({
 *   auth,
 *   build: (identity) => {
 *     const fuji = openFuji({ ... });
 *     return { userId: identity.user.id, fuji, [Symbol.dispose]() {...} };
 *   },
 * });
 * export const { requireApp } = session;
 * export type Fuji = InferApp<typeof session>;
 * ```
 */

import type { AuthClient, WorkspaceIdentity } from '@epicenter/auth';
import {
	createSessionLifecycle,
	type SessionLifecycleConfig,
} from './session-lifecycle.js';

export type SessionPayload<T> = {
	identity: WorkspaceIdentity;
	app: T;
};

export type Session<T> = SessionPayload<T> | null;

export type AppBase = {
	userId: string;
} & Disposable;

/**
 * Infer the app handle type from a session created by `createSession`.
 *
 * Lets per-app modules define the app shape in one place (the build
 * factory) and derive the exported type from it, rather than declaring the
 * type up front and matching it inside the factory.
 *
 * @example
 * ```ts
 * export const session = createSession({ auth, build: (identity) => {...} });
 * export type Fuji = InferApp<typeof session>;
 * ```
 */
export type InferApp<TSession extends { current: unknown }> =
	TSession['current'] extends infer C
		? C extends { app: infer T }
			? T
			: never
		: never;

export function createSession<TApp extends AppBase>({
	auth,
	build,
}: {
	auth: AuthClient;
	build: (identity: WorkspaceIdentity) => TApp;
}) {
	let payload = $state<SessionPayload<TApp> | null>(null);
	const lifecycle = createSessionLifecycle<TApp>({
		auth,
		build,
		getPayload: () => payload,
		setPayload: (next) => {
			payload = next;
		},
		onDifferentUser: () => {
			location.reload();
			throw new Error('unreachable: reload pending');
		},
	} satisfies SessionLifecycleConfig<TApp>);

	return {
		get current(): Session<TApp> {
			return payload;
		},
		/**
		 * Returns the live app handle, throwing when there is no
		 * authenticated identity. Callers are typically descendants mounted under
		 * the layout's `{#if session.current}` gate. Bind once at script init and
		 * dot-access fields. Do NOT inline into templates; re-evaluation breaks
		 * teardown semantics.
		 */
		requireApp(): TApp {
			if (!payload) {
				throw new Error(
					'requireApp() called without an authenticated session. ' +
						'This indicates a route or component mounted without the layout gate, ' +
						'or a callback firing after the app was disposed.',
				);
			}
			return payload.app;
		},
		[Symbol.dispose]() {
			lifecycle[Symbol.dispose]();
		},
	};
}
