import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { ResolveSession, SessionResolution } from './auth-transport.js';
import { type AuthOperation, type AuthSession, type AuthSessionStorage, readStatusCode } from './auth-types.js';

type AuthCommandReason = 'sign-in' | 'sign-up' | 'google-sign-in';

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
	workspaceKeyBase64?: string;
};

export type AuthCommandResult =
	| AuthRefreshResult
	| {
			session: AuthSession;
			error: AuthCommandError;
	  };

export type AuthCommandHandlers = {
	signIn?: (input: {
		email: string;
		password: string;
	}) => Promise<SessionResolution>;
	signUp?: (input: {
		email: string;
		password: string;
		name: string;
	}) => Promise<SessionResolution>;
	signInWithGoogle?: () => Promise<SessionResolution>;
};

export type CreateAuthSessionOptions = {
	storage: AuthSessionStorage;
	resolveSession: ResolveSession;
	commands?: AuthCommandHandlers;
	signOutRemote?: (current: AuthSession) => Promise<void>;
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
};

export function createAuthSession({
	storage,
	resolveSession,
	commands,
	signOutRemote,
}: CreateAuthSessionOptions): AuthClient {
	let operation = $state<AuthOperation>({ status: 'bootstrapping' });
	let initializationPromise: Promise<void> | null = null;
	const authFetch: AuthFetch = (input, init) => {
		const headers = new Headers(init?.headers);
		const token = getToken(storage.current);
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

	async function persistSession(next: AuthSession) {
		if (areSessionsEqual(storage.current, next)) return;
		await storage.set(next);
	}

	async function applyResolvedSession(
		result: SessionResolution,
	): Promise<AuthRefreshResult> {
		switch (result.status) {
			case 'unchanged':
				return { session: storage.current };
			case 'anonymous':
				await persistSession({ status: 'anonymous' });
				return { session: storage.current };
			case 'authenticated':
				await persistSession({
					status: 'authenticated',
					token: result.token,
					user: result.user,
				});
				return {
					session: storage.current,
					workspaceKeyBase64: result.userKeyBase64,
				};
		}
	}

	async function initializeSession() {
		if (!initializationPromise) {
			initializationPromise = (async () => {
				await Promise.all([storage.whenReady].filter(Boolean));
				setOperation({ status: 'idle' });
			})();
		}

		return await initializationPromise;
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
				session: storage.current,
				error: AuthCommandError.SessionHydrationFailed({ reason }).error,
			};
		}

		try {
			return await applyResolvedSession(result);
		} catch (error) {
			return {
				session: storage.current,
				error: AuthCommandError.SessionCommitFailed({
					reason,
					cause: error,
				}).error,
			};
		}
	}

	async function executeAuthCommand(
		execute: () => Promise<SessionResolution>,
		opts: {
			reason: AuthCommandReason;
			mapCatchError: (error: unknown) => AuthCommandError;
		},
	): Promise<AuthCommandResult> {
		await initializeSession();
		setOperation({ status: 'signing-in' });
		try {
			return await completeAuthCommand(await execute(), {
				reason: opts.reason,
			});
		} catch (error) {
			return {
				session: storage.current,
				error: opts.mapCatchError(error),
			};
		} finally {
			setOperation({ status: 'idle' });
		}
	}

	void initializeSession();

	return {
		get session() {
			return storage.current;
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
				return await applyResolvedSession(await resolveSession(storage.current));
			} catch (error) {
				reportBackgroundAuthError('refresh', error);
				return { session: storage.current };
			} finally {
				setOperation({ status: 'idle' });
			}
		},

		signIn(input) {
			const signIn = commands?.signIn;
			if (!signIn) {
				return Promise.resolve({
					session: storage.current,
					error: AuthCommandError.SignInFailed({
						cause: new Error('Sign-in is not configured.'),
					}).error,
				});
			}
			return executeAuthCommand(() => signIn(input), {
				reason: 'sign-in',
				mapCatchError: mapSignInFailure,
			});
		},

		signUp(input) {
			const signUp = commands?.signUp;
			if (!signUp) {
				return Promise.resolve({
					session: storage.current,
					error: AuthCommandError.SignUpFailed({
						cause: new Error('Sign-up is not configured.'),
					}).error,
				});
			}
			return executeAuthCommand(() => signUp(input), {
				reason: 'sign-up',
				mapCatchError: (error) => AuthCommandError.SignUpFailed({ cause: error }).error,
			});
		},

		signInWithGoogle() {
			const signInWithGoogle = commands?.signInWithGoogle;
			if (!signInWithGoogle) {
				return Promise.resolve({
					session: storage.current,
					error: AuthCommandError.GoogleSignInFailed({
						cause: new Error('Google sign-in is not configured.'),
					}).error,
				});
			}
			return executeAuthCommand(() => signInWithGoogle(), {
				reason: 'google-sign-in',
				mapCatchError: mapGoogleSignInFailure,
			});
		},

		async signOut() {
			await initializeSession();
			setOperation({ status: 'signing-out' });

			try {
				await signOutRemote?.(storage.current);
			} catch { /* best-effort — local state resets regardless */ }

			try {
				await persistSession({ status: 'anonymous' });
			} catch (error) {
				reportBackgroundAuthError('sign-out', error);
			} finally {
				setOperation({ status: 'idle' });
			}
		},

		fetch: authFetch,
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

function getToken(session: AuthSession): string | null {
	return session.status === 'authenticated' ? session.token : null;
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

function mapSignInFailure(error: unknown): AuthCommandError {
	if (isInvalidCredentialsError(error)) {
		return AuthCommandError.InvalidCredentials().error;
	}

	return AuthCommandError.SignInFailed({ cause: error }).error;
}

function mapGoogleSignInFailure(error: unknown): AuthCommandError {
	if (isCancelledGoogleSignIn(error)) {
		return AuthCommandError.GoogleSignInCancelled().error;
	}

	return AuthCommandError.GoogleSignInFailed({ cause: error }).error;
}

function isCancelledGoogleSignIn(error: unknown): boolean {
	if (!(error instanceof Error)) return false;

	const message = error.message.toLowerCase();
	return message.includes('canceled') || message.includes('cancelled');
}

function isInvalidCredentialsError(error: unknown): boolean {
	const status = readStatusCode(error);
	if (status === 401 || status === 403) {
		return true;
	}

	const message = extractErrorMessage(error).toLowerCase();
	return (
		message.includes('invalid email or password') ||
		message.includes('invalid credentials') ||
		message.includes('invalid password')
	);
}


function reportBackgroundAuthError(phase: 'refresh' | 'sign-out', error: unknown) {
	console.error(`[auth] ${phase} failed:`, error);
}
