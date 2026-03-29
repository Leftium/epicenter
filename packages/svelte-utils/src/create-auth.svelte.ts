import type { SessionResponse } from '@epicenter/api/types';
import type { BetterAuthOptions } from 'better-auth';
import { createAuthClient, InferPlugin } from 'better-auth/client';
import type { customSession } from 'better-auth/plugins';
import { createSubscriber } from 'svelte/reactivity';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
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
 * Session data passed to the `onLogin` hook.
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
export type AuthLoginEvent = {
	token: string;
	user: StoredUser;
	keyVersion: number;
	userKeyBase64: string;
};

export type AuthClient = {
	readonly session: AuthSession;

	/**
	 * Whether the user is currently authenticated.
	 *
	 * Convenience getter that eliminates the need for consumers to check
	 * `auth.session.status === 'authenticated'` in every component. Reads from
	 * the same external session box as `session`, so it requires the
	 * `createSubscriber` subscription to be active.
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
	 * Narrows the `AuthSession` discriminated union once at the source so every
	 * consumer doesn't repeat the same `status === 'authenticated' ? session.user : null`
	 * pattern. Reads from the external session box via `createSubscriber`.
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
	 * session so consumers don't repeat the `status === 'authenticated'`
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

	readonly isInitializing: boolean;

	/**
	 * Whether a user-initiated auth operation (sign-in, sign-up, sign-out) is
	 * in progress.
	 *
	 * Unlike `isInitializing` (which tracks the initial Better Auth session
	 * resolution and is one-way), `isBusy` toggles on and off with each auth
	 * command. Use it to disable buttons and show spinners during auth flows.
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
	onLogin?: (session: AuthLoginEvent) => void;
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
 * Better Auth's canonical pattern is `customSessionClient<typeof auth>()`, but
 * `typeof auth` drags in server-only types client packages cannot resolve.
 * `InferPlugin<T>()` directly wraps the server plugin type as
 * `$InferServerPlugin`—same mechanism, less indirection.
 */
type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<SessionResponse, BetterAuthOptions>
>;

/**
 * Create a single auth client that owns transport and session lifecycle.
 *
 * BA's `useSession.subscribe()` drives reactive state via `createSubscriber`.
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
	let initializing = $state(true);

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
				if (newToken && session.current.status === 'authenticated') {
					session.current = { ...session.current, token: newToken };
				}
			},
		},
	});

	const subscribe = createSubscriber((update) => {
		return client.useSession.subscribe((state) => {
			if (state.isPending) return;

			initializing = false;
			const prev = session.current;

			if (state.data) {
				const user = normalizeUser(state.data.user);
				const token = state.data.session.token;
				session.current = { status: 'authenticated', token, user };
				onLogin?.({
					token,
					user,
					keyVersion: state.data.keyVersion,
					userKeyBase64: state.data.userKeyBase64,
				});
			} else {
				session.current = { status: 'anonymous' };
				if (prev.status === 'authenticated') {
					onLogout?.();
				}
			}

			update();
		});
	});


	const currentToken = () =>
		session.current.status === 'authenticated'
			? session.current.token
			: null;

	return {
		get session() {
			subscribe();
			return session.current;
		},

		get isAuthenticated() {
			subscribe();
			return session.current.status === 'authenticated';
		},

		get user() {
			subscribe();
			return session.current.status === 'authenticated'
				? session.current.user
				: null;
		},

		get token() {
			subscribe();
			return currentToken();
		},

		get isInitializing() {
			subscribe();
			return initializing;
		},

		get isBusy() {
			subscribe();
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
				if (error)
					return AuthCommandError.GoogleSignInFailed({ cause: error });
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
			try {
				await client.signOut();
			} catch (error) {
				console.error('[auth] sign-out failed:', error);
			} finally {
				if (session.current.status !== 'anonymous') {
					session.current = { status: 'anonymous' };
					onLogout?.();
				}
				busy = false;
			}
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
