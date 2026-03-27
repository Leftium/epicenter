import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	AuthenticatedSessionLoadError,
	type AuthTransport,
	type RemoteAuthResult,
} from './auth-transport.js';
import type {
	AuthOperation,
	AuthSession,
	AuthSessionStorage,
	StoredUser,
} from './auth-types.js';

type ExplicitAuthCommand = 'sign-in' | 'sign-up' | 'google-sign-in';

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
	SessionHydrationFailed: ({
		command,
	}: {
		command: ExplicitAuthCommand;
	}) => ({
		message: `${describeCommand(command)} completed, but the authenticated session could not be loaded.`,
		command,
	}),
	SessionCommitFailed: ({
		command,
		cause,
	}: {
		command: ExplicitAuthCommand;
		cause: unknown;
	}) => ({
		message: `${describeCommand(command)} succeeded, but app session setup failed: ${extractErrorMessage(cause)}`,
		command,
		cause,
	}),
});
export type AuthCommandError = InferErrors<typeof AuthCommandError>;
export type AuthCommandResult = Result<void, AuthCommandError>;

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

export type CreateAuthSessionOptions = {
	storage: AuthSessionStorage;
	transport: AuthTransport;
	onSessionCommitted?: (
		args: AuthSessionCommit,
	) => void | Promise<void>;
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
	onTokenChange(listener: (token: string | null) => void): () => void;

	fetch: typeof fetch;
};

export function createAuthSession({
	storage,
	transport,
	onSessionCommitted,
}: CreateAuthSessionOptions): AuthSessionStore {
	let observedSession = $state<AuthSession>(storage.current);
	let operation = $state<AuthOperation>({ status: 'bootstrapping' });
	let bootstrapPromise: Promise<void> | null = null;
	let isApplyingLocalSessionChange = false;
	let lastPublishedToken = getToken(storage.current);

	const sessionListeners = new Set<(session: AuthSession) => void>();
	const tokenListeners = new Set<(token: string | null) => void>();

	function setOperation(next: AuthOperation) {
		if (operation.status === next.status) return;
		operation = next;
	}

	function notifySessionChange(next: AuthSession) {
		for (const listener of sessionListeners) {
			listener(next);
		}
	}

	function notifyTokenChange(next: AuthSession) {
		const nextToken = getToken(next);
		if (nextToken === lastPublishedToken) return;
		lastPublishedToken = nextToken;
		for (const listener of tokenListeners) {
			listener(nextToken);
		}
	}

	async function runSessionCommitted(args: AuthSessionCommit) {
		if (!onSessionCommitted) return;
		await onSessionCommitted(args);
	}

	async function adoptSession(
		next: AuthSession,
		{
			previous = observedSession,
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
		observedSession = next;

		if (changed) {
			notifySessionChange(next);
			notifyTokenChange(next);
		}

		if (changed || runEffects) {
			await runSessionCommitted({
				previous,
				current: next,
				reason,
				userKeyBase64,
			});
		}
	}

	async function commitSession(
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
		const previous = observedSession;
		const changed = !areSessionsEqual(previous, next);

		if (changed) {
			isApplyingLocalSessionChange = true;
			try {
				await storage.set(next);
			} finally {
				isApplyingLocalSessionChange = false;
			}
		}

		await adoptSession(next, {
			previous,
			reason,
			runEffects,
			userKeyBase64,
		});
	}

	function toSession(result: RemoteAuthResult): AuthSession | null {
		if (result.status === 'unchanged') return null;
		if (result.status === 'anonymous') return { status: 'anonymous' };
		return {
			status: 'authenticated',
			token: result.token,
			user: result.user,
		};
	}

async function applyRemoteResult(
	result: RemoteAuthResult,
	reason: Exclude<AuthSessionCommitReason, 'external-change'>,
) {
	const next = toSession(result);
	if (!next) return;

	try {
		await commitSession(next, {
			reason,
			runEffects: result.status === 'authenticated',
			userKeyBase64:
				result.status === 'authenticated' ? result.userKeyBase64 : undefined,
		});
	} catch (error) {
		throw new AuthSessionCommitError(error);
	}
}

	async function bootstrap() {
		if (!bootstrapPromise) {
			bootstrapPromise = (async () => {
				await Promise.all([storage.whenReady].filter(Boolean));

				const hydratedSession = storage.current;
				try {
					await adoptSession(hydratedSession, {
						reason: 'bootstrap',
						runEffects: hydratedSession.status === 'authenticated',
					});
				} catch (error) {
					reportBackgroundAuthError('bootstrap', error);
				}

				if (hydratedSession.status === 'authenticated') {
					try {
						await applyRemoteResult(
							await transport.getSession(hydratedSession),
							'bootstrap',
						);
					} catch (error) {
						reportBackgroundAuthError('bootstrap', error);
					}
				}

				setOperation({ status: 'idle' });
			})();
		}

		return await bootstrapPromise;
	}

	async function refresh() {
		await bootstrap();
		setOperation({ status: 'refreshing' });

		try {
			await applyRemoteResult(await transport.getSession(storage.current), 'refresh');
		} catch (error) {
			reportBackgroundAuthError('refresh', error);
		}

		setOperation({ status: 'idle' });
	}

	async function runSigningInCommand(
		command: ExplicitAuthCommand,
		run: () => Promise<RemoteAuthResult>,
	): Promise<AuthCommandResult> {
		await bootstrap();
		setOperation({ status: 'signing-in' });

		try {
			await applyRemoteResult(await run(), command);
		} catch (error) {
			setOperation({ status: 'idle' });
			return Err(toAuthCommandError(command, error));
		}

		setOperation({ status: 'idle' });
		return Ok(undefined);
	}

	storage.watch((next) => {
		if (isApplyingLocalSessionChange) return;
		if (areSessionsEqual(observedSession, next)) return;

		setOperation({ status: 'idle' });
		void adoptSession(next, {
			reason: 'external-change',
			runEffects: true,
		}).catch((error) => {
			reportBackgroundAuthError('external-change', error);
		});
	});

	return {
		get whenReady() {
			return bootstrap();
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

		refresh,

		signIn(input) {
			return runSigningInCommand('sign-in', () => transport.signIn(input));
		},

		signUp(input) {
			return runSigningInCommand('sign-up', () => transport.signUp(input));
		},

		signInWithGoogle() {
			return runSigningInCommand('google-sign-in', () =>
				transport.signInWithGoogle(),
			);
		},

		async signOut() {
			await bootstrap();
			setOperation({ status: 'signing-out' });

			try {
				await transport.signOut(storage.current);
			} catch {}

			try {
				await commitSession(
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

function shouldSuppressAuthError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return message.includes('canceled') || message.includes('cancelled');
}

function toAuthCommandError(
	command: ExplicitAuthCommand,
	error: unknown,
): AuthCommandError {
	if (error instanceof AuthenticatedSessionLoadError) {
		return AuthCommandError.SessionHydrationFailed({ command });
	}

	if (error instanceof AuthSessionCommitError) {
		return AuthCommandError.SessionCommitFailed({
			command,
			cause: error.cause,
		});
	}

	if (command === 'google-sign-in' && shouldSuppressAuthError(error)) {
		return AuthCommandError.GoogleSignInCancelled();
	}

	if (command === 'sign-in' && isInvalidCredentialsError(error)) {
		return AuthCommandError.InvalidCredentials();
	}

	switch (command) {
		case 'sign-in':
			return AuthCommandError.SignInFailed({ cause: error });
		case 'sign-up':
			return AuthCommandError.SignUpFailed({ cause: error });
		case 'google-sign-in':
			return AuthCommandError.GoogleSignInFailed({ cause: error });
	}
}

function isInvalidCredentialsError(error: unknown): boolean {
	if (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		(error.status === 401 || error.status === 403)
	) {
		return true;
	}

	const message = extractErrorMessage(error).toLowerCase();
	return (
		message.includes('invalid email or password') ||
		message.includes('invalid credentials') ||
		message.includes('invalid password')
	);
}

function describeCommand(command: ExplicitAuthCommand): string {
	switch (command) {
		case 'sign-in':
			return 'Sign-in';
		case 'sign-up':
			return 'Sign-up';
		case 'google-sign-in':
			return 'Google sign-in';
	}
}

function reportBackgroundAuthError(phase: AuthSessionCommitReason, error: unknown) {
	console.error(`[auth] ${phase} failed:`, error);
}

class AuthSessionCommitError extends Error {
	override readonly cause: unknown;

	constructor(cause: unknown) {
		super('Auth session commit failed', { cause });
		this.name = 'AuthSessionCommitError';
		this.cause = cause;
	}
}
