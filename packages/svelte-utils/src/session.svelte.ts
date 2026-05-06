/**
 * Shared session state machine for apps that gate UI on a signed-in identity
 * plus an app-defined payload (typically a workspace handle).
 *
 * Owns the auth subscription, transition writes, and the live-user-switch
 * refusal. Apps configure two hooks: `build` constructs the signed-in payload
 * from an identity; `applyKeys` applies rotated encryption keys in place.
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
	| { status: 'pending' }
	| { status: 'signed-out' }
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
	let session = $state<Session<TSignedIn>>({ status: 'pending' });

	function next(
		prev: Session<TSignedIn>,
		a: AuthState,
	): Session<TSignedIn> {
		if (a.status === 'pending') {
			return prev.status === 'pending' ? prev : { status: 'pending' };
		}
		if (a.status === 'signed-out') {
			if (prev.status === 'signed-in') prev.signedIn[Symbol.dispose]();
			return { status: 'signed-out' };
		}
		if (prev.status === 'signed-in') {
			if (prev.signedIn.identity.user.id === a.identity.user.id) {
				applyKeys(prev.signedIn, a.identity);
				return {
					status: 'signed-in',
					signedIn: { ...prev.signedIn, identity: a.identity },
				};
			}
			prev.signedIn[Symbol.dispose]();
			location.reload();
			throw new Error('unreachable: reload pending');
		}
		return { status: 'signed-in', signedIn: build(a.identity) };
	}

	const unsubscribe = auth.onStateChange((s) => {
		session = next(session, s);
	});
	// Initial replay: auth may have already settled before subscribe ran.
	session = next(session, auth.state);

	return {
		get current() {
			return session;
		},
		[Symbol.dispose]() {
			unsubscribe();
			if (session.status === 'signed-in') {
				session.signedIn[Symbol.dispose]();
			}
		},
	};
}
