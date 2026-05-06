/**
 * Shared session state machine for apps that gate UI on a signed-in identity
 * plus an app-defined payload (typically a workspace handle).
 *
 * Status comes directly from `auth.state`; this factory only owns the payload
 * lifecycle (build, applyKeys, dispose) and the live-user-switch refusal.
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
 *   applyKeys: (s, i) => s.fuji.encryption.applyKeys(i.encryptionKeys),
 * });
 * ```
 */

import type { AuthClient, AuthIdentity, AuthState } from '@epicenter/auth';

export type Session<TSignedIn> =
	| Exclude<AuthState, { status: 'signed-in' }>
	| { status: 'signed-in'; signedIn: TSignedIn };

export type SignedInBase = {
	readonly identity: AuthIdentity;
} & Disposable;

export function createSession<TSignedIn extends SignedInBase>({
	auth,
	build,
	applyKeys,
}: {
	auth: AuthClient;
	build: (identity: AuthIdentity) => TSignedIn;
	applyKeys: (signedIn: TSignedIn, identity: AuthIdentity) => void;
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
		if (signedIn.identity.user.id === a.identity.user.id) {
			applyKeys(signedIn, a.identity);
			signedIn = { ...signedIn, identity: a.identity };
			return;
		}
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
