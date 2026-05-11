import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { createAuthClient } from 'better-auth/client';
import { Ok } from 'wellcrafted/result';
import type { AuthClient } from './auth-contract.js';
import {
	authStateFromIdentity,
	createAuthStateStore,
	identitiesEqual,
} from './auth-state-store.js';
import { AuthError } from './auth-errors.js';
import type { AuthIdentity } from './auth-types.js';
import { epicenterCustomSessionPlugin } from './better-auth-session.js';
import { authIdentityFromAuthSessionResponse } from './contracts/auth-session.js';
import { headersFromRequest } from './request-headers.js';

export type CreateCookieAuthConfig = {
	/** Resolved once at construction; recreate the client if the origin changes. */
	baseURL?: string;
	/** Optional callback URL for redirect-based social sign-in. */
	getSocialCallbackURL?: () => string | undefined;
	initialIdentity?: AuthIdentity | null;
	saveIdentity?: (value: AuthIdentity | null) => void | Promise<void>;
};

/**
 * Create an auth client for apps that authenticate via the first-party cookie jar.
 */
export function createCookieAuth({
	baseURL = EPICENTER_API_URL,
	getSocialCallbackURL,
	initialIdentity = null,
	saveIdentity,
}: CreateCookieAuthConfig): AuthClient {
	let lastPersisted: AuthIdentity | null = initialIdentity;
	let hasDisposed = false;
	const stateStore = createAuthStateStore(
		initialIdentity === null
			? { status: 'pending' }
			: { status: 'signed-in', identity: initialIdentity },
	);

	function maybePersistIdentity(next: AuthIdentity | null) {
		if (identitiesEqual(lastPersisted, next)) return;
		lastPersisted = next;
		void Promise.resolve(saveIdentity?.(next)).catch((error) => {
			console.error('[auth] failed to save identity:', error);
		});
	}

	function applyBetterAuthSession(data: unknown) {
		let next: AuthIdentity | null;
		try {
			next = authIdentityFromAuthSessionResponse(data);
		} catch (error) {
			console.error('[auth] invalid auth-session response:', error);
			return;
		}
		stateStore.setState(authStateFromIdentity(next));
		maybePersistIdentity(next);
	}

	function clearCookieIdentity() {
		stateStore.setState({ status: 'signed-out' });
		maybePersistIdentity(null);
	}

	const betterAuthClient = createAuthClient({
		baseURL,
		basePath: '/auth',
		plugins: [epicenterCustomSessionPlugin()],
	});

	const unsubscribeBetterAuth = betterAuthClient.useSession.subscribe(
		(sessionState) => {
			if (sessionState.isPending) return;
			applyBetterAuthSession(sessionState.data);
		},
	);

	return {
		get state() {
			return stateStore.state;
		},
		get bearerToken() {
			return null;
		},
		onStateChange: stateStore.onStateChange,
		async signIn(input) {
			try {
				const { error } = await betterAuthClient.signIn.email(input);
				if (!error) return Ok(undefined);
				if (error.status === 401 || error.status === 403) {
					return AuthError.InvalidCredentials();
				}
				return AuthError.SignInFailed({ cause: error });
			} catch (error) {
				return AuthError.SignInFailed({ cause: error });
			}
		},
		async signUp(input) {
			try {
				const { error } = await betterAuthClient.signUp.email(input);
				if (error) return AuthError.SignUpFailed({ cause: error });
				return Ok(undefined);
			} catch (error) {
				return AuthError.SignUpFailed({ cause: error });
			}
		},
		async signInWithSocial(input) {
			try {
				const callbackURL = getSocialCallbackURL?.();
				const { error } = await betterAuthClient.signIn.social({
					provider: input.provider,
					...(callbackURL ? { callbackURL } : {}),
				});
				if (error) return AuthError.SocialSignInFailed({ cause: error });
				return Ok(undefined);
			} catch (cause) {
				return AuthError.SocialSignInFailed({ cause });
			}
		},
		async signOut() {
			try {
				const { error } = await betterAuthClient.signOut();
				if (error) return AuthError.SignOutFailed({ cause: error });
				clearCookieIdentity();
				return Ok(undefined);
			} catch (error) {
				return AuthError.SignOutFailed({ cause: error });
			}
		},
		fetch(input, init) {
			const headers = headersFromRequest(input, init);
			headers.delete('Authorization');
			return fetch(input, { ...init, headers, credentials: 'include' });
		},
		[Symbol.dispose]() {
			if (hasDisposed) return;
			hasDisposed = true;
			unsubscribeBetterAuth();
			stateStore.clearListeners();
		},
	};
}
