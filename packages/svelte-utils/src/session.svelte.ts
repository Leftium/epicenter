/**
 * Shared session state machine for apps that gate UI on a signed-in identity
 * plus an app-defined payload (typically a workspace handle).
 *
 * Status comes directly from `auth.state`; this factory only owns the payload
 * lifecycle (build, dispose) and the identity-mutation refusal (any change to
 * identity after open disposes the payload and reloads the page; see
 * "Why we don't apply keys in place" in the spec). `current` projects
 * `auth.state` and decorates the signed-in variant with the built payload, so
 * apps consume one read API and TypeScript narrows in one step.
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

import {
	type AuthClient,
	type AuthIdentity,
	type AuthState,
	identitiesEqual,
} from '@epicenter/auth';

export type Session<TSignedIn> =
	| Exclude<AuthState, { status: 'signed-in' }>
	| { status: 'signed-in'; signedIn: TSignedIn };

export type SignedInBase = {
	readonly identity: AuthIdentity;
} & Disposable;

export function createSession<TSignedIn extends SignedInBase>({
	auth,
	build,
}: {
	auth: AuthClient;
	build: (identity: AuthIdentity) => TSignedIn;
}) {
	let signedIn = $state<TSignedIn | undefined>(undefined);

	function reconcile(a: AuthState) {
		if (a.status !== 'signed-in') {
			if (signedIn) {
				signedIn[Symbol.dispose]();
				signedIn = undefined;
			}
			return;
		}
		if (!signedIn) {
			signedIn = build(a.identity);
			return;
		}
		// Benign re-emit (auth refetched, identity unchanged): no-op.
		if (identitiesEqual(signedIn.identity, a.identity)) return;
		// Anything else (different user, rotated keys, profile edit): dispose
		// and reload. See "Why we don't apply keys in place" in the spec.
		signedIn[Symbol.dispose]();
		location.reload();
		throw new Error('unreachable: reload pending');
	}

	const unsubscribe = auth.onStateChange(reconcile);
	// Initial replay: auth may have already settled before subscribe ran.
	reconcile(auth.state);

	return {
		get current(): Session<TSignedIn> {
			const a = auth.state;
			if (a.status !== 'signed-in') return a;
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
