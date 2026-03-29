import type { SessionResponse } from '@epicenter/api/types';
import type { BetterAuthOptions } from 'better-auth';
import { createAuthClient, InferPlugin } from 'better-auth/client';
import type { customSession } from 'better-auth/plugins';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';
import {
	type AuthSession,
	readStatusCode,
	type StoredUser,
} from './auth-types.js';

type BaseURL = string | (() => string);

export const AuthCommandError = defineErrors({
	InvalidCredentials: () => ({
		message: 'Invalid email or password.',
	}),
	SignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to sign in: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignUpFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to create account: ${extractErrorMessage(cause)}`,
		cause,
	}),
	GoogleSignInCancelled: () => ({
		message: 'Google sign-in was cancelled.',
	}),
	GoogleSignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to sign in with Google: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AuthCommandError = InferErrors<typeof AuthCommandError>;

export type AuthFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

/**
 * Authenticated session data passed to the `onLogin` hook.
 *
 * Includes `userKeyBase64` so apps can call `workspace.unlockWithKey()`
 * directly—no separate fetch or version tracking needed. The persisted
 * session box stores the simpler `AuthSession` without key material.
 *
 * @example
 * ```typescript
 * createAuth({
 *   onLogin(session) {
 *     workspace.unlockWithKey(session.userKeyBase64);
 *   },
 * });
 * ```
 */
export type AuthenticatedSession = {
	token: string;
	user: StoredUser;
	keyVersion: number;
	userKeyBase64: string;
};

export type AuthClient = {
	/**
	 * Whether the user is currently authenticated.
	 * Convenience getter so consumers don't manually check the session
	 * discriminated union in every component.
	 *
	 * @example
	 * ```svelte
	 * {#if auth.isAuthenticated}
	 *   <p>Welcome back, {auth.user?.name}!</p>
	 * {:else}
	 *   <AuthForm />
	 * {/if}
	 * ```
	 */
	readonly isAuthenticated: boolean;

	/**
	 * The current user, or `null` if not authenticated.
	 *
	 * Narrows the `AuthSession` nullable value once at the source so every
	 * consumer doesn't repeat the same `session ? session.user : null` pattern.
	 *
	 * @example
	 * ```svelte
	 * {#if auth.user}
	 *   <p>{auth.user.name} — {auth.user.email}</p>
	 * {/if}
	 * ```
	 */
	readonly user: StoredUser | null;

	/**
	 * The current session token, or `null` if not authenticated.
	 *
	 * Same narrowing as `user`—extracts the token from the authenticated
	 * session so consumers don't repeat the `session ? session.token : null`
	 * ternary in every `getToken` callback.
	 *
	 * @example
	 * ```typescript
	 * createSyncExtension({
	 *   getToken: async () => auth.token,
	 * })
	 * ```
	 */
	readonly token: string | null;
	/**
	 * Whether a user-initiated auth operation (sign-in, sign-up, sign-out) is
	 * in progress. Toggles on and off with each auth command. Use it to
	 * disable buttons and show spinners during auth flows.
	 *
	 * @example
	 * ```svelte
	 * <Button disabled={auth.isBusy}>
	 *   {#if auth.isBusy}
	 *     <Spinner />
	 *   {:else}
	 *     Sign in
	 *   {/if}
	 * </Button>
	 * ```
	 */
	readonly isBusy: boolean;

	signIn(input: {
		email: string;
		password: string;
	}): Promise<Result<undefined, AuthCommandError>>;
	signUp(input: {
		email: string;
		password: string;
		name: string;
	}): Promise<Result<undefined, AuthCommandError>>;
	signInWithGoogle(): Promise<Result<undefined, AuthCommandError>>;
	signOut(): Promise<void>;
	/**
	 * Redirect-based Google sign-in for web apps. Navigates away from the
	 * current page—no `isBusy` toggle or `Result` return since the browser
	 * leaves before either would be useful.
	 */
	signInWithGoogleRedirect(options: { callbackURL: string }): Promise<void>;

	fetch: AuthFetch;
};

export type CreateAuthOptions = {
	baseURL: BaseURL;
	session: { current: AuthSession };
	/**
	 * Called whenever the session is authenticated—sign-in, session restore
	 * from storage, or token refresh.
	 *
	 * Fires on every authenticated session update, not just login transitions.
	 * Consumers should use idempotent operations (e.g. `unlockWithKey` is safe
	 * to call repeatedly with the same key).
	 *
	 * @example
	 * ```typescript
	 * onLogin(session) {
	 *   workspace.unlockWithKey(session.userKeyBase64);
	 *   workspace.extensions.sync.reconnect();
	 * }
	 * ```
	 */
	onLogin?: (session: AuthenticatedSession) => void;
	/**
	 * Called on the authenticated → anonymous transition only.
	 *
	 * NOT called on cold start when no prior session exists—only when a
	 * previously authenticated session ends (explicit sign-out or server
	 * revocation). Use this to clear local data and disconnect sync.
	 *
	 * @example
	 * ```typescript
	 * onLogout() {
	 *   workspace.clearLocalData();
	 *   workspace.extensions.sync.reconnect();
	 * }
	 * ```
	 */
	onLogout?: () => void;
	signInWithGoogle?: () => Promise<{ idToken: string; nonce: string }>;
};

/**
 * Compile-time bridge for Better Auth's custom session type inference.
 *
 * The canonical pattern is `customSessionClient<typeof auth>()`, but `typeof auth`
 * drags in server-only types that client packages in a monorepo cannot resolve.
 * `InferPlugin<T>()` is a first-party export from `better-auth/client` that sets
 * the same `$InferServerPlugin` property without requiring a fabricated auth shape.
 */
type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<SessionResponse, BetterAuthOptions>
>;

/**
 * Create a single auth client that owns transport and session lifecycle.
 *
 * BA's `useSession.subscribe()` drives reactive state—writes to the `$state`-backed
 * session box so getters are reactive without additional subscription wiring.
 * Commands return errors only—subscribe handles the success path.
 * `session.current` is the source of truth. This module only reads/writes the
 * box and does not own persistence.
 */
export function createAuth({
	baseURL,
	session,
	onLogin,
	onLogout,
	signInWithGoogle: signInWithGoogleOption,
}: CreateAuthOptions): AuthClient {
	let busy = $state(false);

	const client = createAuthClient({
		baseURL: typeof baseURL === 'function' ? baseURL() : baseURL,
		basePath: '/auth',
		plugins: [InferPlugin<EpicenterCustomSessionPlugin>()],
		fetchOptions: {
			auth: {
				type: 'Bearer',
				token: () => currentToken() ?? undefined,
			},
			onSuccess: (context) => {
				const newToken = context.response.headers.get('set-auth-token');
				if (newToken && session.current !== null) {
					session.current = { ...session.current, token: newToken };
				}
			},
		},
	});

	client.useSession.subscribe((state) => {
		if (state.isPending) return;

		const prev = session.current;

		if (state.data) {
			const user = normalizeUser(state.data.user);
			const token = state.data.session.token;
			session.current = { token, user };
			onLogin?.({
				token,
				user,
				keyVersion: state.data.keyVersion,
				userKeyBase64: state.data.userKeyBase64,
			});
		} else {
			session.current = null;
			if (prev !== null) {
				onLogout?.();
			}
		}
	});

	const currentToken = () =>
		session.current !== null ? session.current.token : null;

	return {
		get isAuthenticated() {
			return session.current !== null;
		},

		get user() {
			return session.current !== null ? session.current.user : null;
		},

		get token() {
			return currentToken();
		},

		get isBusy() {
			return busy;
		},

		async signIn(input) {
			busy = true;
			try {
				const { error } = await client.signIn.email(input);
				if (!error) return Ok(undefined);
				const status = readStatusCode(error);
				if (status === 401 || status === 403)
					return AuthCommandError.InvalidCredentials();
				return AuthCommandError.SignInFailed({ cause: error });
			} catch (error) {
				return AuthCommandError.SignInFailed({ cause: error });
			} finally {
				busy = false;
			}
		},

		async signUp(input) {
			busy = true;
			try {
				const { error } = await client.signUp.email(input);
				if (error) return AuthCommandError.SignUpFailed({ cause: error });
				return Ok(undefined);
			} catch (error) {
				return AuthCommandError.SignUpFailed({ cause: error });
			} finally {
				busy = false;
			}
		},

		async signInWithGoogle() {
			if (!signInWithGoogleOption) {
				return AuthCommandError.GoogleSignInFailed({
					cause: new Error('Google sign-in is not configured.'),
				});
			}

			busy = true;
			try {
				const { idToken, nonce } = await signInWithGoogleOption();
				const { error } = await client.signIn.social({
					provider: 'google',
					idToken: { token: idToken, nonce },
				});
				if (error) return AuthCommandError.GoogleSignInFailed({ cause: error });
				return Ok(undefined);
			} catch (error) {
				if (isCancelledGoogleSignIn(error))
					return AuthCommandError.GoogleSignInCancelled();
				return AuthCommandError.GoogleSignInFailed({ cause: error });
			} finally {
				busy = false;
			}
		},

		async signOut() {
			busy = true;
			await tryAsync({
				try: () => client.signOut(),
				catch: (error) => {
					console.error('[auth] sign-out failed:', error);
					return Ok(undefined);
				},
			});
			busy = false;
		},

		async signInWithGoogleRedirect({ callbackURL }) {
			await client.signIn.social({ provider: 'google', callbackURL });
		},

		fetch(input: RequestInfo | URL, init?: RequestInit) {
			const headers = new Headers(init?.headers);
			const token = currentToken();
			if (token) headers.set('Authorization', `Bearer ${token}`);
			return fetch(input, { ...init, headers, credentials: 'include' });
		},
	};
}

function normalizeUser(user: {
	id: string;
	createdAt: Date;
	updatedAt: Date;
	email: string;
	emailVerified: boolean;
	name: string;
	image?: string | null;
}): StoredUser {
	return {
		id: user.id,
		createdAt: user.createdAt.toISOString(),
		updatedAt: user.updatedAt.toISOString(),
		email: user.email,
		emailVerified: user.emailVerified,
		name: user.name,
		image: user.image,
	};
}

function isCancelledGoogleSignIn(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return message.includes('canceled') || message.includes('cancelled');
}
