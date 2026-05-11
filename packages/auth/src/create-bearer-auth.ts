import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { createAuthClient } from 'better-auth/client';
import { Ok, type Result } from 'wellcrafted/result';
import type { AuthClient, SocialProvider } from './auth-contract.js';
import {
	authStateFromIdentity,
	createAuthStateStore,
	identitiesEqual,
} from './auth-state-store.js';
import { AuthError } from './auth-errors.js';
import type { AuthIdentity, BearerSession } from './auth-types.js';
import { epicenterCustomSessionPlugin } from './better-auth-session.js';
import {
	bearerSessionFromBetterAuthSessionResponse,
	normalizeBearerSession,
} from './contracts/auth-session.js';
import { headersFromRequest } from './request-headers.js';

export type BearerSessionStorage = {
	/**
	 * Reads the durable bearer session once during auth client construction.
	 *
	 * This value seeds the in-memory bearer credential used by Better Auth's
	 * first session request. Storage is not the live source of truth after
	 * construction.
	 */
	get(): BearerSession | null;
	/**
	 * Persists the current bearer session for the next boot.
	 *
	 * The auth client calls this when Better Auth validates, rotates, or clears
	 * the session. The auth client remains the live runtime owner.
	 */
	set(value: BearerSession | null): void | Promise<void>;
};

export type CreateBearerAuthConfig = {
	/** Resolved once at construction; recreate the client if the origin changes. */
	baseURL?: string;
	sessionStorage: BearerSessionStorage;
	oauthAdapter?: OAuthSocialSignInAdapter;
};

export type OAuthSocialSignInAdapter = {
	signInWithSocial(input: {
		provider: SocialProvider;
	}): Promise<Result<{ accessToken: string } | null, unknown>>;
};

/**
 * Create an auth client for runtimes that must carry their own bearer token.
 */
export function createBearerAuth({
	baseURL = EPICENTER_API_URL,
	sessionStorage,
	oauthAdapter,
}: CreateBearerAuthConfig): AuthClient {
	let session: BearerSession | null = sessionStorage.get();
	let pendingBearerToken: string | null = null;
	let hasDisposed = false;

	const stateStore = createAuthStateStore(
		session === null
			? { status: 'pending' }
			: authStateFromIdentity(identityFromSession(session)),
	);

	function persistSession(next: BearerSession | null) {
		void Promise.resolve(sessionStorage.set(next)).catch((error) => {
			console.error('[auth] failed to save session:', error);
		});
	}

	function applyBetterAuthSession(data: unknown) {
		let parsed: BearerSession | null;
		try {
			parsed = bearerSessionFromBetterAuthSessionResponse(data);
		} catch (error) {
			console.error('[auth] invalid Better Auth session response:', error);
			return;
		}
		const next: BearerSession | null =
			parsed === null
				? null
				: {
						token: pendingBearerToken ?? session?.token ?? parsed.token,
						user: parsed.user,
						encryptionKeys: parsed.encryptionKeys,
					};
		if (next === null) pendingBearerToken = null;
		if (sessionsEqual(session, next)) {
			// Carries the pending -> settled transition on the first BA replay
			// (both stored and replayed sessions can be null). setState dedupes
			// otherwise, so this is a no-op for steady-state equal sessions.
			stateStore.setState(authStateFromIdentity(identityFromSession(next)));
			return;
		}
		applyBearerSession(next);
	}

	function applyBearerSession(next: BearerSession | null) {
		session = next;
		pendingBearerToken = null;
		stateStore.setState(authStateFromIdentity(identityFromSession(next)));
		persistSession(next);
	}

	function clearBearerSession() {
		if (session === null && pendingBearerToken === null) return;
		session = null;
		pendingBearerToken = null;
		stateStore.setState({ status: 'signed-out' });
		persistSession(null);
	}

	function rememberBearerToken(newToken: string) {
		if (session === null) {
			pendingBearerToken = newToken;
			return;
		}
		if (session.token === newToken) return;
		session = { ...session, token: newToken };
		persistSession(session);
	}

	async function hydrateInitialBearerSession(token: string) {
		const response = await fetch(`${baseURL}/auth/get-session`, {
			headers: { Authorization: `Bearer ${token}` },
			credentials: 'omit',
		});
		if (!response.ok) {
			throw new Error(`Session fetch failed with ${response.status}.`);
		}
		const data = await response.json();
		if (data === null) {
			throw new Error('Bearer token did not resolve a session.');
		}
		const responseToken = response.headers.get('set-auth-token') ?? token;
		applyBearerSession(normalizeBearerSession(data, { token: responseToken }));
	}

	async function hydrateSignedOutSession(token: string | null) {
		if (session !== null) return;
		const firstToken = pendingBearerToken ?? token;
		if (!firstToken) {
			throw new Error('Bearer sign-in did not return a session token.');
		}
		try {
			await hydrateInitialBearerSession(firstToken);
		} catch (error) {
			if (pendingBearerToken === firstToken) pendingBearerToken = null;
			throw error;
		}
	}

	async function applyOAuthAccessToken(
		accessToken: string,
	): Promise<Result<undefined, AuthError>> {
		try {
			const response = await fetch(`${baseURL}/auth/oauth-session`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${accessToken}` },
				credentials: 'omit',
			});
			if (!response.ok) {
				return AuthError.SocialSignInFailed({
					cause: new Error(`Session fetch failed with ${response.status}.`),
				});
			}
			const data = await response.json();
			if (data === null) {
				return AuthError.SocialSignInFailed({
					cause: new Error('OAuth access token did not resolve a session.'),
				});
			}
			const token = response.headers.get('set-auth-token');
			if (!token) {
				return AuthError.SocialSignInFailed({
					cause: new Error('OAuth session did not return a bearer token.'),
				});
			}
			applyBearerSession(normalizeBearerSession(data, { token }));
			return Ok(undefined);
		} catch (cause) {
			return AuthError.SocialSignInFailed({ cause });
		}
	}

	const betterAuthClient = createAuthClient({
		baseURL,
		basePath: '/auth',
		plugins: [epicenterCustomSessionPlugin()],
		fetchOptions: {
			credentials: 'omit',
			auth: {
				type: 'Bearer',
				token: () => session?.token ?? pendingBearerToken ?? undefined,
			},
			onSuccess: (context) => {
				const newToken = context.response.headers.get('set-auth-token');
				if (newToken) rememberBearerToken(newToken);
			},
		},
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
			return session?.token ?? null;
		},
		onStateChange: stateStore.onStateChange,
		async signIn(input) {
			try {
				const { data, error } = await betterAuthClient.signIn.email(input);
				if (!error) {
					await hydrateSignedOutSession(readTokenFromAuthCommandData(data));
					return Ok(undefined);
				}
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
				const { data, error } = await betterAuthClient.signUp.email(input);
				if (error) return AuthError.SignUpFailed({ cause: error });
				await hydrateSignedOutSession(readTokenFromAuthCommandData(data));
				return Ok(undefined);
			} catch (error) {
				return AuthError.SignUpFailed({ cause: error });
			}
		},
		async signInWithSocial(input) {
			if (!oauthAdapter) {
				return AuthError.SocialSignInFailed({
					cause: new Error(
						'Social sign-in is not configured for this runtime.',
					),
				});
			}
			const result = await oauthAdapter.signInWithSocial(input);
			if (result.error) {
				return AuthError.SocialSignInFailed({ cause: result.error });
			}
			if (result.data === null) return Ok(undefined);
			return await applyOAuthAccessToken(result.data.accessToken);
		},
		async signOut() {
			try {
				const { error } = await betterAuthClient.signOut();
				if (error) return AuthError.SignOutFailed({ cause: error });
				clearBearerSession();
				return Ok(undefined);
			} catch (error) {
				return AuthError.SignOutFailed({ cause: error });
			}
		},
		fetch(input, init) {
			const headers = headersFromRequest(input, init);
			if (session !== null) {
				headers.set('Authorization', `Bearer ${session.token}`);
			} else {
				headers.delete('Authorization');
			}
			return fetch(input, { ...init, headers, credentials: 'omit' });
		},
		[Symbol.dispose]() {
			if (hasDisposed) return;
			hasDisposed = true;
			unsubscribeBetterAuth();
			stateStore.clearListeners();
		},
	};
}

function identityFromSession(value: BearerSession | null): AuthIdentity | null {
	if (value === null) return null;
	return {
		user: value.user,
		encryptionKeys: value.encryptionKeys,
	};
}

function sessionsEqual(
	left: BearerSession | null,
	right: BearerSession | null,
) {
	if (left === null || right === null) return left === right;
	return (
		left.token === right.token &&
		identitiesEqual(identityFromSession(left), identityFromSession(right))
	);
}

function readTokenFromAuthCommandData(value: unknown): string | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const token = (value as { token?: unknown }).token;
	return typeof token === 'string' ? token : null;
}
