/**
 * Shared session state machine for apps that gate UI on a signed-in identity
 * plus an app-defined payload (typically a workspace handle).
 *
 * Status comes directly from `auth.state`; this factory only owns the payload
 * lifecycle (build, dispose) and the user-switch refusal (different `user.id`
 * disposes the payload and reloads the page). Same-user identity changes
 * (key rotation, profile edits) are no-ops here: the payload's lazy callbacks
 * pick up updates the next time they read `auth.state`.
 *
 * `current` projects `auth.state` and decorates the signed-in variant with the
 * built payload, so apps consume one read API and TypeScript narrows in one
 * step.
 *
 * Requires an `AuthClient` whose `state` is Svelte-reactive (use
 * `@epicenter/auth-svelte`, not `@epicenter/auth` directly).
 *
 * @example
 * ```ts
 * type FujiSignedIn = SignedInBase & { fuji: Fuji };
 * export const session = createSession<FujiSignedIn>({
 *   auth,
 *   build: (identity) => buildFujiSignedIn(identity),
 * });
 * ```
 */

import type { AuthClient, AuthIdentity, AuthState } from '@epicenter/auth';

export type Session<TSignedIn> =
	| Exclude<AuthState, { status: 'signed-in' }>
	| { status: 'signed-in'; signedIn: TSignedIn };

export type SignedInBase = {
	userId: string;
} & Disposable;

export function createSession<TSignedIn extends SignedInBase>({
	auth,
	build,
}: {
	auth: AuthClient;
	build: (identity: AuthIdentity) => TSignedIn;
}) {
	let signedIn = $state<TSignedIn | undefined>(undefined);

	function reconcile(state: AuthState) {
		if (state.status !== 'signed-in') {
			if (signedIn) {
				signedIn[Symbol.dispose]();
				signedIn = undefined;
			}
			return;
		}
		if (!signedIn) {
			signedIn = build(state.identity);
			return;
		}
		// Same user: no-op. The payload's lazy reads through `auth.state`
		// observe any identity update (key rotation, profile edits) without
		// involving the workspace lifecycle.
		if (signedIn.userId === state.identity.user.id) return;
		// Different user: refuse the live switch and reload (heap safety).
		signedIn[Symbol.dispose]();
		location.reload();
		throw new Error('unreachable: reload pending');
	}

	const unsubscribe = auth.onStateChange(reconcile);
	// Initial replay: auth may have already settled before subscribe ran.
	reconcile(auth.state);

	return {
		get current(): Session<TSignedIn> {
			if (auth.state.status === 'pending') return { status: 'pending' };
			if (auth.state.status === 'signed-out') return { status: 'signed-out' };
			// Invariant: reconcile runs synchronously inside onStateChange, so
			// `signedIn` is always set when auth is signed-in. Defensive fallback
			// keeps the type honest without an `!`.
			if (!signedIn) return { status: 'pending' };
			return { status: 'signed-in', signedIn };
		},
		[Symbol.dispose]() {
			unsubscribe();
			signedIn?.[Symbol.dispose]();
		},
	};
}
