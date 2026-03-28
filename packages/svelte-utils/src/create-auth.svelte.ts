import type {
	SessionResponse,
	WorkspaceKeyResponse,
} from '@epicenter/api/types';
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
import {
	type AuthOperation,
	type AuthSession,
	readStatusCode,
	type StoredUser,
} from './auth-types.js';

export type { WorkspaceKeyResponse };

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
 * Includes `keyVersion` from BA's session data so apps can decide whether
 * to fetch a new workspace key. The persisted box (`session.current`) stores
 * the simpler `AuthSession` without `keyVersion`.
 */
export type AuthSessionEvent =
	| {
			status: 'authenticated';
			token: string;
			user: StoredUser;
			keyVersion: number;
	  }
	| { status: 'anonymous' };

export type AuthClient = {
	readonly session: AuthSession;
	readonly operation: AuthOperation;
	readonly isPending: boolean;

	signIn(input: {
		email: string;
		password: string;
	}): Promise<AuthCommandError | undefined>;
	signUp(input: {
		email: string;
		password: string;
		name: string;
	}): Promise<AuthCommandError | undefined>;
	signInWithGoogle(): Promise<AuthCommandError | undefined>;
	signOut(): Promise<void>;
	signInWithGoogleRedirect(options: { callbackURL: string }): Promise<void>;

	fetch: AuthFetch;
	fetchWorkspaceKey(): Promise<WorkspaceKeyResponse>;
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
	let operation = $state<AuthOperation>({ status: 'idle' });
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

	const authFetch: AuthFetch = (input, init) => {
		const headers = new Headers(init?.headers);
		const token = getToken(session.current);
		if (token) {
			headers.set('Authorization', `Bearer ${token}`);
		}
		return fetch(input, { ...init, headers, credentials: 'include' });
	};

	return {
		get session() {
			subscribe();
			return session.current;
		},

		get operation() {
			return operation;
		},

		get isPending() {
			subscribe();
			return pending;
		},

		async signIn(input) {
			operation = { status: 'signing-in' };
			try {
				const { error } = await client.signIn.email(input);
				if (error) return classifySignInError(error);
				return undefined;
			} catch (error) {
				return AuthCommandError.SignInFailed({ cause: error }).error;
			} finally {
				operation = { status: 'idle' };
			}
		},

		async signUp(input) {
			operation = { status: 'signing-in' };
			try {
				const { error } = await client.signUp.email(input);
				if (error)
					return AuthCommandError.SignUpFailed({ cause: error }).error;
				return undefined;
			} catch (error) {
				return AuthCommandError.SignUpFailed({ cause: error }).error;
			} finally {
				operation = { status: 'idle' };
			}
		},

		async signInWithGoogle() {
			if (!signInWithGoogleOption) {
				return AuthCommandError.GoogleSignInFailed({
					cause: new Error('Google sign-in is not configured.'),
				}).error;
			}

			operation = { status: 'signing-in' };
			try {
				const { idToken, nonce } = await signInWithGoogleOption();
				const { error } = await client.signIn.social({
					provider: 'google',
					idToken: { token: idToken, nonce },
				});
				if (error)
					return AuthCommandError.GoogleSignInFailed({ cause: error })
						.error;
				return undefined;
			} catch (error) {
				if (isCancelledGoogleSignIn(error)) {
					return AuthCommandError.GoogleSignInCancelled().error;
				}
				return AuthCommandError.GoogleSignInFailed({ cause: error }).error;
			} finally {
				operation = { status: 'idle' };
			}
		},

		async signOut() {
			operation = { status: 'signing-out' };
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
				operation = { status: 'idle' };
			}
		},

		async signInWithGoogleRedirect({ callbackURL }) {
			await client.signIn.social({ provider: 'google', callbackURL });
		},

		fetch: authFetch,

		async fetchWorkspaceKey() {
			const url = typeof baseURL === 'function' ? baseURL() : baseURL;
			const response = await authFetch(`${url}/workspace-key`);
			if (!response.ok) {
				throw new Error(
					`Failed to fetch workspace key: ${response.status}`,
				);
			}
			return response.json() as Promise<WorkspaceKeyResponse>;
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

function getToken(current: AuthSession): string | null {
	return current.status === 'authenticated' ? current.token : null;
}

function classifySignInError(error: unknown): AuthCommandError {
	const status = readStatusCode(error);
	if (status === 401 || status === 403) {
		return AuthCommandError.InvalidCredentials().error;
	}
	return AuthCommandError.SignInFailed({ cause: error }).error;
}

function isCancelledGoogleSignIn(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return message.includes('canceled') || message.includes('cancelled');
}
