import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type {
	GoogleSignInResult,
	ResolveSession,
	SessionResolution,
} from './auth-transport.js';
import type {
	AuthOperation,
	AuthSession,
	AuthSessionStorage,
	StoredUser,
} from './auth-types.js';

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
export type AuthCommandResult = Result<void, AuthCommandError>;

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
	signInWithGoogle?: () => Promise<GoogleSignInResult>;
};

export type AuthSessionCommitReason =
	| 'bootstrap'
	| 'refresh'
	| 'sign-in'
	| 'sign-up'
	| 'google-sign-in'
	| 'sign-out'
	| 'external-change';

export type AuthSessionCommit = {
	previous: AuthSession;
	current: AuthSession;
	reason: AuthSessionCommitReason;
	userKeyBase64?: string | null;
};
export type AuthSessionCommitListener = (
	commit: AuthSessionCommit,
) => void | Promise<void>;

export type CreateAuthSessionOptions = {
	storage: AuthSessionStorage;
	resolveSession: ResolveSession;
	commands?: AuthCommandHandlers;
	signOutRemote?: (current: AuthSession) => Promise<void>;
};

export type AuthSessionStore = {
	readonly whenReady: Promise<void>;
	readonly session: AuthSession;
	readonly operation: AuthOperation;
	readonly isAuthenticated: boolean;
	readonly user: StoredUser | null;
	readonly token: string | null;

	refresh(): Promise<void>;
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

	onSessionChange(listener: (session: AuthSession) => void): () => void;
	onSessionCommit(listener: AuthSessionCommitListener): () => void;
	onTokenChange(listener: (token: string | null) => void): () => void;

	fetch: typeof fetch;
};

export function createAuthSession({
	storage,
	resolveSession,
	commands,
	signOutRemote,
}: CreateAuthSessionOptions): AuthSessionStore {
	let publishedSession = $state<AuthSession>(storage.current);
	let operation = $state<AuthOperation>({ status: 'bootstrapping' });
	let initializationPromise: Promise<void> | null = null;
	let isApplyingLocalSessionChange = false;
	let lastPublishedToken = getToken(storage.current);

	const sessionListeners = new Set<(session: AuthSession) => void>();
	const sessionCommitListeners = new Set<AuthSessionCommitListener>();
	const tokenListeners = new Set<(token: string | null) => void>();

	function setOperation(next: AuthOperation) {
		if (operation.status === next.status) return;
		operation = next;
	}

	async function publishSession(
		next: AuthSession,
		{
			previous = publishedSession,
			reason,
			runEffects = false,
			userKeyBase64,
		}: {
			previous?: AuthSession;
			reason: AuthSessionCommitReason;
			runEffects?: boolean;
			userKeyBase64?: string | null;
		},
	) {
		const changed = !areSessionsEqual(previous, next);
		publishedSession = next;

		if (changed) {
			for (const listener of sessionListeners) {
				listener(next);
			}

			const nextToken = getToken(next);
			if (nextToken !== lastPublishedToken) {
				lastPublishedToken = nextToken;
				for (const listener of tokenListeners) {
					listener(nextToken);
				}
			}
		}

		if (!changed && !runEffects) {
			return;
		}

		if (sessionCommitListeners.size === 0) {
			return;
		}

		const commit = {
			previous,
			current: next,
			reason,
			userKeyBase64,
		} satisfies AuthSessionCommit;

		for (const listener of sessionCommitListeners) {
			await listener(commit);
		}
	}

	async function persistAndPublishSession(
		next: AuthSession,
		{
			reason,
			runEffects = false,
			userKeyBase64,
		}: {
			reason: AuthSessionCommitReason;
			runEffects?: boolean;
			userKeyBase64?: string | null;
		},
	) {
		const previous = publishedSession;
		const changed = !areSessionsEqual(previous, next);

		if (changed) {
			isApplyingLocalSessionChange = true;
			try {
				await storage.set(next);
			} finally {
				isApplyingLocalSessionChange = false;
			}
		}

		await publishSession(next, {
			previous,
			reason,
			runEffects,
			userKeyBase64,
		});
	}

	async function applyResolvedSession(
		result: SessionResolution,
		reason: Exclude<AuthSessionCommitReason, 'external-change'>,
	) {
		switch (result.status) {
			case 'unchanged':
				return;
			case 'anonymous':
				await persistAndPublishSession({ status: 'anonymous' }, { reason });
				return;
			case 'authenticated':
				await persistAndPublishSession(
					{
						status: 'authenticated',
						token: result.token,
						user: result.user,
					},
					{
						reason,
						runEffects: true,
						userKeyBase64: result.userKeyBase64,
					},
				);
				return;
		}
	}

	async function initializeSession() {
		if (!initializationPromise) {
			initializationPromise = (async () => {
				await Promise.all([storage.whenReady].filter(Boolean));

				const hydratedSession = storage.current;
				try {
					await publishSession(hydratedSession, {
						reason: 'bootstrap',
						runEffects: hydratedSession.status === 'authenticated',
					});
				} catch (error) {
					reportBackgroundAuthError('bootstrap', error);
				}

				if (hydratedSession.status === 'authenticated') {
					try {
						await applyResolvedSession(
							await resolveSession(hydratedSession),
							'bootstrap',
						);
					} catch (error) {
						reportBackgroundAuthError('bootstrap', error);
					}
				}

				setOperation({ status: 'idle' });
			})();
		}

		return await initializationPromise;
	}

	async function completeAuthCommand(
		result: SessionResolution | GoogleSignInResult,
		{
			reason,
			allowRedirectStart = false,
		}: {
			reason: AuthCommandReason;
			allowRedirectStart?: boolean;
		},
	): Promise<AuthCommandResult> {
		if (allowRedirectStart && result.status === 'redirect-started') {
			setOperation({ status: 'idle' });
			return Ok(undefined);
		}

		if (result.status !== 'authenticated') {
			setOperation({ status: 'idle' });
			return AuthCommandError.SessionHydrationFailed({ reason });
		}

		try {
			await applyResolvedSession(result, reason);
		} catch (error) {
			setOperation({ status: 'idle' });
			return AuthCommandError.SessionCommitFailed({
				reason,
				cause: error,
			});
		}

		setOperation({ status: 'idle' });
		return Ok(undefined);
	}

	storage.watch((next) => {
		if (isApplyingLocalSessionChange) return;
		if (areSessionsEqual(publishedSession, next)) return;

		setOperation({ status: 'idle' });
		void publishSession(next, {
			reason: 'external-change',
			runEffects: true,
		}).catch((error) => {
			reportBackgroundAuthError('external-change', error);
		});
	});

	return {
		get whenReady() {
			return initializeSession();
		},

		get session() {
			return storage.current;
		},

		get operation() {
			return operation;
		},

		get isAuthenticated() {
			return storage.current.status === 'authenticated';
		},

		get user() {
			return storage.current.status === 'authenticated'
				? storage.current.user
				: null;
		},

		get token() {
			return getToken(storage.current);
		},

		async refresh() {
			await initializeSession();
			setOperation({ status: 'refreshing' });

			try {
				await applyResolvedSession(
					await resolveSession(storage.current),
					'refresh',
				);
			} catch (error) {
				reportBackgroundAuthError('refresh', error);
			}

			setOperation({ status: 'idle' });
		},

		signIn(input) {
			const signIn = commands?.signIn;
			if (!signIn) {
				return AuthCommandError.SignInFailed({
					cause: new Error('Sign-in is not configured.'),
				});
			}

			return (async () => {
				await initializeSession();
				setOperation({ status: 'signing-in' });

				let result: SessionResolution;
				try {
					result = await signIn(input);
				} catch (error) {
					setOperation({ status: 'idle' });
					return mapSignInFailure(error);
				}

				return await completeAuthCommand(result, { reason: 'sign-in' });
			})();
		},

		signUp(input) {
			const signUp = commands?.signUp;
			if (!signUp) {
				return AuthCommandError.SignUpFailed({
					cause: new Error('Sign-up is not configured.'),
				});
			}

			return (async () => {
				await initializeSession();
				setOperation({ status: 'signing-in' });

				let result: SessionResolution;
				try {
					result = await signUp(input);
				} catch (error) {
					setOperation({ status: 'idle' });
					return AuthCommandError.SignUpFailed({ cause: error });
				}

				return await completeAuthCommand(result, { reason: 'sign-up' });
			})();
		},

		signInWithGoogle() {
			const signInWithGoogle = commands?.signInWithGoogle;
			if (!signInWithGoogle) {
				return AuthCommandError.GoogleSignInFailed({
					cause: new Error('Google sign-in is not configured.'),
				});
			}

			return (async () => {
				await initializeSession();
				setOperation({ status: 'signing-in' });

				let result: GoogleSignInResult;
				try {
					result = await signInWithGoogle();
				} catch (error) {
					setOperation({ status: 'idle' });
					return mapGoogleSignInFailure(error);
				}

				return await completeAuthCommand(result, {
					reason: 'google-sign-in',
					allowRedirectStart: true,
				});
			})();
		},

		async signOut() {
			await initializeSession();
			setOperation({ status: 'signing-out' });

			try {
				await signOutRemote?.(storage.current);
			} catch {}

			try {
				await persistAndPublishSession(
					{ status: 'anonymous' },
					{ reason: 'sign-out', runEffects: true },
				);
			} catch (error) {
				reportBackgroundAuthError('sign-out', error);
			}

			setOperation({ status: 'idle' });
		},

		onSessionChange(listener) {
			sessionListeners.add(listener);
			return () => {
				sessionListeners.delete(listener);
			};
		},

		onSessionCommit(listener) {
			sessionCommitListeners.add(listener);
			return () => {
				sessionCommitListeners.delete(listener);
			};
		},

		onTokenChange(listener) {
			tokenListeners.add(listener);
			return () => {
				tokenListeners.delete(listener);
			};
		},

		fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
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
		}) as typeof fetch,
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
		return AuthCommandError.InvalidCredentials();
	}

	return AuthCommandError.SignInFailed({ cause: error });
}

function mapGoogleSignInFailure(error: unknown): AuthCommandError {
	if (isCancelledGoogleSignIn(error)) {
		return AuthCommandError.GoogleSignInCancelled();
	}

	return AuthCommandError.GoogleSignInFailed({ cause: error });
}

function isCancelledGoogleSignIn(error: unknown): boolean {
	if (!(error instanceof Error)) return false;

	const message = error.message.toLowerCase();
	return message.includes('canceled') || message.includes('cancelled');
}

function isInvalidCredentialsError(error: unknown): boolean {
	const status =
		typeof error === 'object' && error !== null && 'status' in error
			? (error as { status?: unknown }).status
			: undefined;
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

function reportBackgroundAuthError(
	phase: AuthSessionCommitReason,
	error: unknown,
) {
	console.error(`[auth] ${phase} failed:`, error);
}
