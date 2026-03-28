import type { EpicenterSessionResponse } from '@epicenter/api/types';
import type { BetterAuthOptions } from 'better-auth';
import { createAuthClient } from 'better-auth/client';
import { customSessionClient } from 'better-auth/client/plugins';
import type { customSession } from 'better-auth/plugins';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type AuthOperation,
	type AuthSession,
	readStatusCode,
	type StoredUser,
} from './auth-types.js';

type BaseURL = string | (() => string);
type AuthCommandReason = 'sign-in' | 'sign-up' | 'google-sign-in';

/** Response shape from `GET /workspace-key`. */
export type WorkspaceKeyResponse = {
	userKeyBase64: string;
	keyVersion: number;
};

/**
 * Local auth resolution result used by app state.
 *
 * The canonical remote `/auth/get-session` contract is owned by the API. This
 * union is a separate layer that adds client flow states the API never returns
 * directly: anonymous and unchanged.
 */
export type SessionResolution =
	| {
			status: 'authenticated';
			token: string;
			user: StoredUser;
			keyVersion: number;
	  }
	| { status: 'anonymous' }
	| { status: 'unchanged' };

/**
 * Typed errors for the auth transport layer.
 *
 * These wrap Better Auth's raw `BetterFetchError` at the transport boundary so
 * callers can match on named variants instead of reading unknown error objects.
 */
export const AuthTransportError = defineErrors({
	InvalidCredentials: ({ cause }: { cause: unknown }) => ({
		message: `Invalid email or password: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RequestFailed: ({ status, cause }: { status: number; cause: unknown }) => ({
		message: `Auth request failed (${status}): ${extractErrorMessage(cause)}`,
		status,
		cause,
	}),
	UnexpectedError: ({ cause }: { cause: unknown }) => ({
		message: `Unexpected auth error: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AuthTransportError = InferErrors<typeof AuthTransportError>;

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
	SessionHydrationFailed: ({ reason }: { reason: AuthCommandReason }) => ({
		message: `${describeCommand(reason)} completed, but the authenticated session could not be loaded.`,
		reason,
	}),
	SessionCommitFailed: ({
		reason,
		cause,
	}: {
		reason: AuthCommandReason;
		cause: unknown;
	}) => ({
		message: `${describeCommand(reason)} succeeded, but app session setup failed: ${extractErrorMessage(cause)}`,
		reason,
		cause,
	}),
});
export type AuthCommandError = InferErrors<typeof AuthCommandError>;

export type AuthRefreshResult = {
	session: AuthSession;
	keyVersion?: number;
};

export type AuthCommandResult =
	| AuthRefreshResult
	| {
			session: AuthSession;
			error: AuthCommandError;
	  };

export type AuthFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export type AuthClient = {
	readonly session: AuthSession;
	readonly operation: AuthOperation;
	readonly isRefreshing: boolean;

	refresh(): Promise<AuthRefreshResult>;
	signIn(input: {
		email: string;
		password: string;
	}): Promise<AuthCommandResult>;
	signUp(input: {
		email: string;
		password: string;
		name: string;
	}): Promise<AuthCommandResult>;
	signInWithGoogle(): Promise<AuthCommandResult>;
	signOut(): Promise<void>;

	fetch: AuthFetch;
	fetchWorkspaceKey(): Promise<WorkspaceKeyResponse>;
};

export type CreateAuthOptions = {
	baseURL: BaseURL;
	session: { current: AuthSession };
	signInWithGoogle?: () => Promise<{ idToken: string; nonce: string }>;
};

/**
 * Compile-time bridge for `customSessionClient<T>()`.
 *
 * Better Auth's canonical pattern is `customSessionClient<typeof auth>()`, but
 * `typeof auth` drags in server-only types client packages cannot resolve.
 */
type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<EpicenterSessionResponse, BetterAuthOptions>
>;
type EpicenterAuthPluginShape = {
	options: { plugins: EpicenterCustomSessionPlugin[] };
};

/**
 * Create a single auth client that owns transport and session lifecycle.
 *
 * `session.current` is the source of truth. This module only reads/writes the
 * box and does not own persistence.
 */
export function createAuth({
	baseURL,
	session,
	signInWithGoogle: signInWithGoogleOption,
}: CreateAuthOptions): AuthClient {
	let operation = $state<AuthOperation>({ status: 'bootstrapping' });
	let initializationPromise: Promise<void> | null = null;

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
		},
	});

	const authFetch: AuthFetch = (input, init) => {
		const headers = new Headers(init?.headers);
		const token = getToken(session.current);
		if (token) {
			headers.set('Authorization', `Bearer ${token}`);
		}

		return fetch(input, {
			...init,
			headers,
			credentials: 'include',
		});
	};

	function setOperation(next: AuthOperation) {
		if (operation.status === next.status) return;
		operation = next;
	}

	function extractCommandToken(data: unknown): string | null {
		if (typeof data !== 'object' || data === null) return null;
		if ('token' in data && typeof data.token === 'string') {
			return data.token;
		}
		if (
			'session' in data &&
			typeof data.session === 'object' &&
			data.session !== null &&
			'token' in data.session &&
			typeof data.session.token === 'string'
		) {
			return data.session.token;
		}
		return null;
	}

	function classifyBetterAuthError(error: unknown) {
		const status = readStatusCode(error);
		if (status === 401 || status === 403) {
			return AuthTransportError.InvalidCredentials({ cause: error });
		}
		if (status !== undefined) {
			return AuthTransportError.RequestFailed({ status, cause: error });
		}
		return AuthTransportError.UnexpectedError({ cause: error });
	}

	async function resolveWithToken(token: string | null): Promise<SessionResolution> {
		const { data, error } = await client.getSession(
			token
				? { fetchOptions: { headers: { Authorization: `Bearer ${token}` } } }
				: undefined,
		);

		if (error) {
			const status = readStatusCode(error);
			return status !== undefined && status < 500
				? { status: 'anonymous' }
				: { status: 'unchanged' };
		}

		if (!data) return { status: 'anonymous' };

		const sessionToken =
			typeof data.session.token === 'string' ? data.session.token : token;
		if (!sessionToken) return { status: 'anonymous' };

		return {
			status: 'authenticated',
			token: sessionToken,
			user: {
				id: data.user.id,
				createdAt: data.user.createdAt.toISOString(),
				updatedAt: data.user.updatedAt.toISOString(),
				email: data.user.email,
				emailVerified: data.user.emailVerified,
				name: data.user.name,
				image: data.user.image,
			} satisfies StoredUser,
			keyVersion: data.keyVersion,
		};
	}

	async function commandThenResolve(
		command: () => Promise<{ data: unknown; error: unknown }>,
	): Promise<Result<SessionResolution, AuthTransportError>> {
		const { data, error } = await command();
		if (error) return classifyBetterAuthError(error);
		return Ok(await resolveWithToken(extractCommandToken(data)));
	}

	function initializeSession() {
		if (!initializationPromise) {
			initializationPromise = Promise.resolve().then(() => {
				setOperation({ status: 'idle' });
			});
		}
		return initializationPromise;
	}

	async function persistSession(next: AuthSession) {
		if (areSessionsEqual(session.current, next)) return;
		session.current = next;
	}

	async function applyResolvedSession(
		result: SessionResolution,
	): Promise<AuthRefreshResult> {
		switch (result.status) {
			case 'unchanged':
				return { session: session.current };
			case 'anonymous':
				await persistSession({ status: 'anonymous' });
				return { session: session.current };
			case 'authenticated':
				await persistSession({
					status: 'authenticated',
					token: result.token,
					user: result.user,
				});
				return {
					session: session.current,
					keyVersion: result.keyVersion,
				};
		}
	}

	async function completeAuthCommand(
		result: SessionResolution,
		{
			reason,
		}: {
			reason: AuthCommandReason;
		},
	): Promise<AuthCommandResult> {
		if (result.status !== 'authenticated') {
			return {
				session: session.current,
				error: AuthCommandError.SessionHydrationFailed({ reason }).error,
			};
		}

		try {
			return await applyResolvedSession(result);
		} catch (error) {
			return {
				session: session.current,
				error: AuthCommandError.SessionCommitFailed({
					reason,
					cause: error,
				}).error,
			};
		}
	}

	async function executeAuthCommand(
		execute: () => Promise<Result<SessionResolution, AuthTransportError>>,
		opts: {
			reason: AuthCommandReason;
			mapTransportError: (error: AuthTransportError) => AuthCommandError;
		},
	): Promise<AuthCommandResult> {
		await initializeSession();
		setOperation({ status: 'signing-in' });

		try {
			const result = await execute();
			if (result.error) {
				return {
					session: session.current,
					error: opts.mapTransportError(result.error),
				};
			}

			return await completeAuthCommand(result.data, { reason: opts.reason });
		} catch (error) {
			return {
				session: session.current,
				error: mapUnexpectedFailure(opts.reason, error),
			};
		} finally {
			setOperation({ status: 'idle' });
		}
	}

	void initializeSession();

	return {
		get session() {
			return session.current;
		},

		get operation() {
			return operation;
		},

		get isRefreshing() {
			return (
				operation.status === 'bootstrapping' ||
				operation.status === 'refreshing'
			);
		},

		async refresh() {
			await initializeSession();
			setOperation({ status: 'refreshing' });

			try {
				return await applyResolvedSession(await resolveWithToken(null));
			} catch (error) {
				reportBackgroundAuthError('refresh', error);
				return { session: session.current };
			} finally {
				setOperation({ status: 'idle' });
			}
		},

		signIn(input) {
			return executeAuthCommand(
				() => commandThenResolve(() => client.signIn.email(input)),
				{
					reason: 'sign-in',
					mapTransportError: mapSignInTransportError,
				},
			);
		},

		signUp(input) {
			return executeAuthCommand(
				() => commandThenResolve(() => client.signUp.email(input)),
				{
					reason: 'sign-up',
					mapTransportError: (error) =>
						AuthCommandError.SignUpFailed({ cause: error }).error,
				},
			);
		},

		signInWithGoogle() {
			if (!signInWithGoogleOption) {
				return Promise.resolve({
					session: session.current,
					error: AuthCommandError.GoogleSignInFailed({
						cause: new Error('Google sign-in is not configured.'),
					}).error,
				});
			}

			return executeAuthCommand(
				async () => {
					const { idToken, nonce } = await signInWithGoogleOption();
					return commandThenResolve(() =>
						client.signIn.social({
							provider: 'google',
							idToken: { token: idToken, nonce },
						}),
					);
				},
				{
					reason: 'google-sign-in',
					mapTransportError: (error) =>
						AuthCommandError.GoogleSignInFailed({ cause: error }).error,
				},
			);
		},

		async signOut() {
			await initializeSession();
			setOperation({ status: 'signing-out' });

			try {
				const { error } = await client.signOut();
				if (error) {
					throw error;
				}
			} catch (error) {
				reportBackgroundAuthError('sign-out', error);
			} finally {
				try {
					await persistSession({ status: 'anonymous' });
				} catch (error) {
					reportBackgroundAuthError('sign-out', error);
				} finally {
					setOperation({ status: 'idle' });
				}
			}
		},

		fetch: authFetch,

		async fetchWorkspaceKey() {
			const token = getToken(session.current);
			if (!token) {
				throw new Error('Cannot fetch workspace key without an authenticated session.');
			}

			const url = typeof baseURL === 'function' ? baseURL() : baseURL;
			const response = await fetch(`${url}/workspace-key`, {
				headers: { Authorization: `Bearer ${token}` },
			});

			if (!response.ok) {
				throw new Error(`Failed to fetch workspace key: ${response.status}`);
			}

			return response.json() as Promise<WorkspaceKeyResponse>;
		},
	};
}

function areSessionsEqual(left: AuthSession, right: AuthSession): boolean {
	if (left.status !== right.status) return false;
	if (left.status === 'anonymous') return true;
	if (right.status === 'anonymous') return false;

	return (
		left.token === right.token &&
		left.user.id === right.user.id &&
		left.user.createdAt === right.user.createdAt &&
		left.user.updatedAt === right.user.updatedAt &&
		left.user.email === right.user.email &&
		left.user.emailVerified === right.user.emailVerified &&
		left.user.name === right.user.name &&
		left.user.image === right.user.image
	);
}

function getToken(current: AuthSession): string | null {
	return current.status === 'authenticated' ? current.token : null;
}

function describeCommand(reason: AuthCommandReason): string {
	switch (reason) {
		case 'sign-in':
			return 'Sign-in';
		case 'sign-up':
			return 'Sign-up';
		case 'google-sign-in':
			return 'Google sign-in';
	}
}

function mapSignInTransportError(error: AuthTransportError): AuthCommandError {
	if (error.name === 'InvalidCredentials') {
		return AuthCommandError.InvalidCredentials().error;
	}
	return AuthCommandError.SignInFailed({ cause: error }).error;
}

function mapUnexpectedFailure(
	reason: AuthCommandReason,
	error: unknown,
): AuthCommandError {
	switch (reason) {
		case 'sign-in':
			return AuthCommandError.SignInFailed({ cause: error }).error;
		case 'sign-up':
			return AuthCommandError.SignUpFailed({ cause: error }).error;
		case 'google-sign-in':
			if (isCancelledGoogleSignIn(error)) {
				return AuthCommandError.GoogleSignInCancelled().error;
			}
			return AuthCommandError.GoogleSignInFailed({ cause: error }).error;
	}
}

function isCancelledGoogleSignIn(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return message.includes('canceled') || message.includes('cancelled');
}

function reportBackgroundAuthError(phase: 'refresh' | 'sign-out', error: unknown) {
	console.error(`[auth] ${phase} failed:`, error);
}
