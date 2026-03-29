import type { SessionResponse } from '@epicenter/api/types';
import type { BetterAuthOptions } from 'better-auth';
import { createAuthClient } from 'better-auth/client';
import { customSessionClient } from 'better-auth/client/plugins';
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
 * Extended session state passed to the `onSessionChange` callback.
 *
 * Includes `userKeyBase64` from the enriched session response so apps can
 * call `workspace.unlockWithKey()` directly—no separate fetch or version
 * tracking needed. The persisted box (`session.current`) stores the simpler
 * `AuthSession` without key material.
 */
export type AuthSessionEvent =
	| {
			status: 'authenticated';
			token: string;
			user: StoredUser;
			keyVersion: number;
			userKeyBase64: string;
	  }
	| { status: 'anonymous' };

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

	readonly isPending: boolean;

	/**
	 * Whether a user-initiated auth operation (sign-in, sign-up, sign-out) is
	 * in progress.
	 *
	 * Unlike `isPending` (which tracks the initial Better Auth session
	 * resolution and is one-way), `isBusy` toggles on and off with each auth
	 * command. Use it to disable buttons and show spinners during auth flows.
	 *
	 * Backed by an internal `$state` variable—no `subscribe()` needed since
	 * it's written directly by the auth methods, not the BA subscription.
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
	onSessionChange?: (next: AuthSessionEvent, prev: AuthSession) => void;
	signInWithGoogle?: () => Promise<{ idToken: string; nonce: string }>;
};

/**
 * Compile-time bridge for `customSessionClient<T>()`.
 *
 * Better Auth's canonical pattern is `customSessionClient<typeof auth>()`, but
 * `typeof auth` drags in server-only types client packages cannot resolve.
 */
type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<SessionResponse, BetterAuthOptions>
>;
type EpicenterAuthPluginShape = {
	options: { plugins: EpicenterCustomSessionPlugin[] };
};

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
	onSessionChange,
	signInWithGoogle: signInWithGoogleOption,
}: CreateAuthOptions): AuthClient {
	let busy = $state(false);
	let pending = $state(true);

	const client = createAuthClient({
		baseURL: typeof baseURL === 'function' ? baseURL() : baseURL,
		basePath: '/auth',
		plugins: [customSessionClient<EpicenterAuthPluginShape>()],
		fetchOptions: {
			auth: {
				type: 'Bearer',
				token: () =>
					session.current.status === 'authenticated'
						? session.current.token
						: undefined,
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

			pending = false;
			const prev = session.current;

			if (state.data) {
				const user = normalizeUser(state.data.user);
				const token = state.data.session.token;
				session.current = { status: 'authenticated', token, user };
				onSessionChange?.(
					{
						status: 'authenticated',
						token,
						user,
						keyVersion: state.data.keyVersion,
						userKeyBase64: state.data.userKeyBase64,
					},
					prev,
				);
			} else {
				session.current = { status: 'anonymous' };
				onSessionChange?.({ status: 'anonymous' }, prev);
			}

			update();
		});
	});


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

		get isPending() {
			subscribe();
			return pending;
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
					const prev = session.current;
					session.current = { status: 'anonymous' };
					onSessionChange?.({ status: 'anonymous' }, prev);
				}
				busy = false;
			}
		},

		async signInWithGoogleRedirect({ callbackURL }) {
			await client.signIn.social({ provider: 'google', callbackURL });
		},

		fetch(input: RequestInfo | URL, init?: RequestInit) {
			const headers = new Headers(init?.headers);
			if (session.current.status === 'authenticated') {
				headers.set('Authorization', `Bearer ${session.current.token}`);
			}
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
