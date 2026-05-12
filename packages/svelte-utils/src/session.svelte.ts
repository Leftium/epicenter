/**
 * Shared session state machine for apps that gate UI on an authenticated
 * identity plus an app-defined payload (typically a workspace handle).
 *
 * `Session<T>` is the projection layer between `AuthState` and the workspace.
 * The shape is the discriminator: `SessionPayload<T> | null`. Apps gate on
 * truthiness (`if (session.current)`). The projection never surfaces credential
 * freshness; consumers that care about it read `auth.state.status` directly.
 *
 * This factory owns the payload lifecycle (build, dispose) and the user-switch
 * refusal (different `user.id` disposes the payload and reloads the page).
 * Disposal is triggered ONLY by `signed-out` or a different `user.id`.
 * Same-user `reauth-required` is a no-op, so local workspace state stays
 * mounted while credentials refresh, and `session.current` keeps the same
 * `SessionPayload` reference across the transition.
 *
 * The returned `requireWorkspace()` method is the standard component-side
 * unwrap helper: it throws if `current` is null, and the thrown error is
 * prefixed with the app `name` passed to `createSession`. Re-export it from
 * each app's session module with `export const { requireWorkspace } = session`.
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
 *   name: 'fuji',
 *   build: (identity) => {
 *     const fuji = openFuji({ ... });
 *     return { userId: identity.user.id, fuji, [Symbol.dispose]() {...} };
 *   },
 * });
 * export const { requireWorkspace } = session;
 * export type FujiWorkspace = InferWorkspace<typeof session>;
 * ```
 */

import {
	createSessionLifecycle,
	type SessionLifecycleConfig,
} from './session-lifecycle.js';
import type { AuthClient, WorkspaceIdentity } from '@epicenter/auth';

export type SessionPayload<T> = {
	identity: WorkspaceIdentity;
	workspace: T;
};

export type Session<T> = SessionPayload<T> | null;

export type WorkspaceBase = {
	userId: string;
} & Disposable;

/**
 * Infer the workspace payload type from a session created by `createSession`.
 *
 * Lets per-app modules define the workspace shape in one place (the build
 * factory) and derive the exported type from it, rather than declaring the
 * type up front and matching it inside the factory.
 *
 * @example
 * ```ts
 * export const session = createSession({ auth, name: 'fuji', build: (identity) => {...} });
 * export type FujiWorkspace = InferWorkspace<typeof session>;
 * ```
 */
export type InferWorkspace<TSession extends { current: unknown }> =
	TSession['current'] extends infer C
		? C extends { workspace: infer T }
			? T
			: never
		: never;

export function createSession<TWorkspace extends WorkspaceBase>({
	auth,
	build,
	name,
}: {
	auth: AuthClient;
	build: (identity: WorkspaceIdentity) => TWorkspace;
	/**
	 * App name prefix used in the `requireWorkspace()` throw, e.g. `"fuji"`
	 * produces `[fuji] requireWorkspace() called without ...`.
	 */
	name: string;
}) {
	let payload = $state<SessionPayload<TWorkspace> | null>(null);
	const lifecycle = createSessionLifecycle<TWorkspace>({
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
	} satisfies SessionLifecycleConfig<TWorkspace>);

	return {
		get current(): Session<TWorkspace> {
			return payload;
		},
		/**
		 * Returns the live workspace payload, throwing when there is no
		 * authenticated identity. Callers (typically `+page.svelte` components
		 * mounted under the layout's `{#if session.current}` gate) bind once at
		 * script init and dot-access fields. Do NOT inline into templates;
		 * re-evaluation breaks teardown semantics.
		 */
		requireWorkspace(): TWorkspace {
			if (!payload) {
				throw new Error(
					`[${name}] requireWorkspace() called without an authenticated session. ` +
						'This indicates a route or component mounted without the layout gate, ' +
						'or a callback firing after the workspace was disposed.',
				);
			}
			return payload.workspace;
		},
		[Symbol.dispose]() {
			lifecycle[Symbol.dispose]();
		},
	};
}
