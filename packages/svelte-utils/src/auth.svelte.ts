import type {
	WorkspaceEncryption,
	WorkspaceEncryptionWithCache,
} from '@epicenter/workspace';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { type } from 'arktype';
import type { User } from 'better-auth';
import { createAuthClient } from 'better-auth/client';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import { createPersistedState } from './persisted-state.svelte';

type CustomSessionFields = {
	encryptionKey: string;
};

const WorkspaceAuthError = defineErrors({
	MissingUserKeyBase64: () => ({
		message: 'Authenticated session is missing userKeyBase64',
	}),
	SignInFailed: ({
		status,
		cause,
	}: {
		status?: number;
		cause: unknown;
	}) => ({
		message: `Sign-in failed: ${extractErrorMessage(cause)}`,
		status,
		cause,
	}),
	SignUpFailed: ({
		status,
		cause,
	}: {
		status?: number;
		cause: unknown;
	}) => ({
		message: `Sign-up failed: ${extractErrorMessage(cause)}`,
		status,
		cause,
	}),
	GoogleSignInFailed: ({
		status,
		cause,
	}: {
		status?: number;
		cause: unknown;
	}) => ({
		message: `Google sign-in failed: ${extractErrorMessage(cause)}`,
		status,
		cause,
	}),
	SignOutFailed: ({
		status,
		cause,
	}: {
		status?: number;
		cause: unknown;
	}) => ({
		message: `Sign-out failed: ${extractErrorMessage(cause)}`,
		status,
		cause,
	}),
	SessionLookupFailed: ({
		status,
		cause,
	}: {
		status?: number;
		cause: unknown;
	}) => ({
		message: `Failed to refresh session: ${extractErrorMessage(cause)}`,
		status,
		cause,
	}),
});
type WorkspaceAuthError = InferErrors<typeof WorkspaceAuthError>;

export const StoredUser = type({
	id: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
});

export type StoredUser = typeof StoredUser.infer;

export type WorkspaceAuthStatus =
	| 'bootstrapping'
	| 'checking'
	| 'signing-in'
	| 'signing-out'
	| 'signed-in'
	| 'signed-out';

export type WorkspaceAuthState = {
	status: WorkspaceAuthStatus;
	user: StoredUser | null;
	token: string | null;
	signInError?: string;
};

export type WorkspaceAuth = {
	readonly state: WorkspaceAuthState;
	readonly status: WorkspaceAuthStatus;
	readonly user: StoredUser | null;
	readonly token: string | null;
	readonly signInError?: string;
	subscribe(listener: (state: WorkspaceAuthState) => void): () => void;
	bootstrap(): Promise<StoredUser | null>;
	refreshSession(): Promise<StoredUser | null>;
	signIn(credentials: { email: string; password: string }): Promise<void>;
	signUp(credentials: {
		email: string;
		password: string;
		name: string;
	}): Promise<void>;
	signInWithGoogle(): Promise<void>;
	signOut(): Promise<void>;
	fetch: typeof fetch;
};

type EmailSignInCredentials = {
	email: string;
	password: string;
};

type EmailSignUpCredentials = {
	email: string;
	password: string;
	name: string;
};

type AuthResult = {
	user: StoredUser;
	token: string | null;
	userKeyBase64?: string | null;
};

type AuthFlowResult =
	| {
			kind: 'authenticated';
			session: AuthResult;
	  }
	| {
			kind: 'redirecting';
	  };

type SessionFieldState<T> = {
	current: T;
	set?: (value: T) => Promise<void>;
	watch?: (callback: (value: T) => void) => (() => void) | undefined;
	whenReady?: Promise<void>;
};

type PendingAction =
	| 'bootstrapping'
	| 'checking'
	| 'signing-in'
	| 'signing-out'
	| null;

type BetterAuthInternalClient = ReturnType<typeof createAuthClient>;

type BetterAuthClient = {
	signIn(credentials: EmailSignInCredentials): Promise<AuthFlowResult>;
	signUp(credentials: EmailSignUpCredentials): Promise<AuthFlowResult>;
	signInWithGoogle(): Promise<AuthFlowResult>;
	signOut(token: string | null): Promise<void>;
	getSession(token: string | null): Promise<AuthResult | null>;
};

type WorkspaceAuthWorkspace = {
	encryption: WorkspaceEncryption | WorkspaceEncryptionWithCache;
	clearLocalData(): Promise<void>;
};

type WorkspaceSessionController = {
	unlock(userKeyBase64: string): Promise<void>;
	tryUnlock(): Promise<boolean>;
	clearLocalData(): Promise<void>;
};

export function createLocalSessionFields(prefix: string) {
	const token = createPersistedState({
		key: `${prefix}:authToken`,
		schema: type('string').or('null'),
		defaultValue: null,
	});
	const user = createPersistedState({
		key: `${prefix}:authUser`,
		schema: StoredUser.or('null'),
		defaultValue: null,
	});

	return {
		token,
		user,
	};
}

export function createWorkspaceAuth({
	baseURL,
	token,
	user,
	workspace,
	signInWithGoogle,
}: {
	baseURL: string | (() => string);
	token: SessionFieldState<string | null>;
	user: SessionFieldState<StoredUser | null>;
	workspace: WorkspaceAuthWorkspace;
	signInWithGoogle?: (
		client: BetterAuthInternalClient,
	) => Promise<{ user: User } & Partial<CustomSessionFields>>;
}): WorkspaceAuth {
	const workspaceSession = createWorkspaceSessionController(workspace);
	const client = createBetterAuthClient({
		baseURL,
		signInWithGoogle,
	});

	let pendingAction = $state<PendingAction>('bootstrapping');
	let lastError = $state<string | undefined>(undefined);
	let hasExternalSession = $state(Boolean(user.current));
	let isApplyingLocalSessionChange = false;
	let bootstrapPromise: Promise<StoredUser | null> | null = null;
	let lastPublishedState: WorkspaceAuthState | null = null;

	const listeners = new Set<(state: WorkspaceAuthState) => void>();

	async function writeField<T>(field: SessionFieldState<T>, value: T) {
		if (field.set) {
			await field.set(value);
			return;
		}
		field.current = value;
	}

	async function writeSession(next: {
		token: string | null;
		user: StoredUser | null;
	}) {
		await writeField(token, next.token);
		await writeField(user, next.user);
	}

	function getStatus(): WorkspaceAuthStatus {
		if (pendingAction) return pendingAction;
		return user.current ? 'signed-in' : 'signed-out';
	}

	function getState(): WorkspaceAuthState {
		const status = getStatus();
		return {
			status,
			user: user.current,
			token: token.current,
			signInError: status === 'signed-out' ? lastError : undefined,
		};
	}

	function statesMatch(
		left: WorkspaceAuthState | null,
		right: WorkspaceAuthState,
	) {
		return (
			left?.status === right.status &&
			left?.user === right.user &&
			left?.token === right.token &&
			left?.signInError === right.signInError
		);
	}

	function notify() {
		const nextState = getState();
		if (statesMatch(lastPublishedState, nextState)) return;
		lastPublishedState = nextState;
		for (const listener of listeners) {
			listener(nextState);
		}
	}

	function setPendingAction(next: PendingAction) {
		if (pendingAction === next) return;
		pendingAction = next;
		notify();
	}

	function setLastError(next: string | undefined) {
		if (lastError === next) return;
		lastError = next;
		notify();
	}

	async function applyLocalSessionChange(
		run: () => void | Promise<void>,
	): Promise<void> {
		isApplyingLocalSessionChange = true;
		try {
			await run();
		} finally {
			isApplyingLocalSessionChange = false;
			hasExternalSession = Boolean(user.current);
			notify();
		}
	}

	async function writeAuthenticatedSession(result: AuthResult) {
		if (!result.userKeyBase64) {
			return WorkspaceAuthError.MissingUserKeyBase64();
		}

		await workspaceSession.unlock(result.userKeyBase64);
		await applyLocalSessionChange(() =>
			writeSession({ user: result.user, token: result.token }),
		);
		setLastError(undefined);
		return Ok(undefined);
	}

	async function clearSession() {
		await workspaceSession.clearLocalData();
		await applyLocalSessionChange(() =>
			writeSession({ user: null, token: null }),
		);
		setLastError(undefined);
	}

	async function authenticate(run: () => Promise<AuthFlowResult>) {
		setPendingAction('signing-in');

		const { data: result, error } = await tryAsync({
			try: () => run(),
			catch: (error) => Err(error),
		});

		if (error) {
			setLastError(
				isCancelledError(error) ? undefined : extractErrorMessage(error),
			);
			setPendingAction(null);
			return;
		}

		if (!result || result.kind === 'redirecting') {
			setPendingAction(null);
			return;
		}

		const { error: writeError } = await writeAuthenticatedSession(
			result.session,
		);
		if (writeError) {
			setLastError(writeError.message);
			setPendingAction(null);
			return;
		}

		setPendingAction(null);
	}

	async function bootstrap() {
		if (!bootstrapPromise) {
			bootstrapPromise = (async () => {
				await Promise.all([token.whenReady, user.whenReady].filter(Boolean));

				const currentUser = user.current;
				if (currentUser) {
					await workspaceSession.tryUnlock();
					setLastError(undefined);
				}

				setPendingAction(null);
				return currentUser;
			})();
		}

		return await bootstrapPromise;
	}

	async function refreshSession() {
		await bootstrap();
		setPendingAction('checking');

		const currentToken = token.current;
		const { data: result, error } = await tryAsync({
			try: () => client.getSession(currentToken),
			catch: (error) =>
				WorkspaceAuthError.SessionLookupFailed({
					status: getErrorStatus(error),
					cause: error,
				}),
		});

		if (error) {
			if (isAuthRejection(error)) {
				await clearSession();
				setPendingAction(null);
				return null;
			}

			const cachedUser = user.current;
			setPendingAction(null);
			return cachedUser;
		}

		if (!result) {
			await clearSession();
			setPendingAction(null);
			return null;
		}

		const { error: writeError } = await writeAuthenticatedSession(result);
		if (writeError) {
			await clearSession();
			setLastError(`Session refresh failed: ${writeError.message}`);
			setPendingAction(null);
			return null;
		}

		setPendingAction(null);
		return result.user;
	}

	const handleExternalSessionChange = () => {
		if (isApplyingLocalSessionChange) return;

		const wasSignedIn = hasExternalSession;
		const isSignedIn = Boolean(user.current);
		hasExternalSession = isSignedIn;

		setPendingAction(null);

		if (!isSignedIn && wasSignedIn) {
			setLastError(undefined);
			void tryAsync({
				try: () => workspaceSession.clearLocalData(),
				catch: () => Ok(undefined),
			});
		} else if (isSignedIn && !wasSignedIn) {
			setLastError(undefined);
			void tryAsync({
				try: () => workspaceSession.tryUnlock(),
				catch: () => Ok(false),
			});
		}

		notify();
	};

	token.watch?.(handleExternalSessionChange);
	user.watch?.(handleExternalSessionChange);

	return {
		get state() {
			return getState();
		},

		get status() {
			return getStatus();
		},

		get user() {
			return user.current;
		},

		get token() {
			return token.current;
		},

		get signInError() {
			return getState().signInError;
		},

		subscribe(listener) {
			listeners.add(listener);
			listener(getState());
			return () => {
				listeners.delete(listener);
			};
		},

		bootstrap,
		refreshSession,

		fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const authToken = token.current;
			if (authToken) {
				headers.set('Authorization', `Bearer ${authToken}`);
			}
			return fetch(input, {
				...init,
				headers,
				credentials: 'include',
			});
		}) as typeof fetch,

		async signIn(credentials) {
			await authenticate(() => client.signIn(credentials));
		},

		async signUp(credentials) {
			await authenticate(() => client.signUp(credentials));
		},

		async signInWithGoogle() {
			await authenticate(() => client.signInWithGoogle());
		},

		async signOut() {
			setPendingAction('signing-out');
			await tryAsync({
				try: () => client.signOut(token.current),
				catch: (error) =>
					WorkspaceAuthError.SignOutFailed({
						status: getErrorStatus(error),
						cause: error,
					}),
			});
			await clearSession();
			setPendingAction(null);
		},
	};
}

function createBetterAuthClient({
	baseURL,
	signInWithGoogle,
}: {
	baseURL: string | (() => string);
	signInWithGoogle?: (
		client: BetterAuthInternalClient,
	) => Promise<{ user: User } & Partial<CustomSessionFields>>;
}): BetterAuthClient {
	const resolveBaseUrl =
		typeof baseURL === 'function' ? baseURL : () => baseURL;

	function buildClient(token: string | null) {
		let nextToken: string | null | undefined;

		const client = createAuthClient({
			baseURL: resolveBaseUrl(),
			basePath: '/auth',
			fetchOptions: {
				auth: {
					type: 'Bearer',
					token: () => token ?? undefined,
				},
				onSuccess: ({ response }) => {
					const issuedToken = response.headers.get('set-auth-token');
					if (issuedToken) nextToken = issuedToken;
				},
			},
		});

		return {
			client,
			getIssuedToken: () => nextToken,
		};
	}

	async function runGoogleSignIn(
		client: BetterAuthInternalClient,
	): Promise<
		| {
				kind: 'completed';
				data: { user: User } & Partial<CustomSessionFields>;
		  }
		| {
				kind: 'redirecting';
		  }
	> {
		if (signInWithGoogle) {
			return {
				kind: 'completed',
				data: await signInWithGoogle(client),
			};
		}

		await client.signIn.social({
			provider: 'google',
			callbackURL: window.location.origin,
		});
		return { kind: 'redirecting' };
	}

	return {
		async signIn(credentials) {
			const { client, getIssuedToken } = buildClient(null);
			const { data, error } = await client.signIn.email(credentials);
			if (error) {
				throw WorkspaceAuthError.SignInFailed({
					status: getErrorStatus(error),
					cause: error,
				});
			}

			return {
				kind: 'authenticated',
				session: toAuthResult(data, getIssuedToken()),
			};
		},

		async signUp(credentials) {
			const { client, getIssuedToken } = buildClient(null);
			const { data, error } = await client.signUp.email(credentials);
			if (error) {
				throw WorkspaceAuthError.SignUpFailed({
					status: getErrorStatus(error),
					cause: error,
				});
			}

			return {
				kind: 'authenticated',
				session: toAuthResult(data, getIssuedToken()),
			};
		},

		async signInWithGoogle() {
			const { client, getIssuedToken } = buildClient(null);

			const { data, error } = await tryAsync({
				try: () => runGoogleSignIn(client),
				catch: (error) =>
					WorkspaceAuthError.GoogleSignInFailed({
						status: getErrorStatus(error),
						cause: error,
					}),
			});
			if (error) throw error;
			if (data.kind === 'redirecting') return data;

			return {
				kind: 'authenticated',
				session: toAuthResult(data.data, getIssuedToken()),
			};
		},

		async signOut(token) {
			const { client } = buildClient(token);
			const { error } = await client.signOut();
			if (error) {
				throw WorkspaceAuthError.SignOutFailed({
					status: getErrorStatus(error),
					cause: error,
				});
			}
		},

		async getSession(token) {
			const { client, getIssuedToken } = buildClient(token);
			const { data, error } = await client.getSession();
			if (error) {
				throw WorkspaceAuthError.SessionLookupFailed({
					status: getErrorStatus(error),
					cause: error,
				});
			}
			if (!data) return null;

			const customData = data as typeof data & Partial<CustomSessionFields>;
			return toAuthResult(customData, getIssuedToken() ?? token);
		},
	};
}

function createWorkspaceSessionController(
	workspace: WorkspaceAuthWorkspace,
): WorkspaceSessionController {
	const { encryption } = workspace;
	const tryUnlock =
		'tryUnlock' in encryption ? () => encryption.tryUnlock() : async () => false;

	return {
		unlock(userKeyBase64) {
			return encryption.unlock(base64ToBytes(userKeyBase64));
		},
		tryUnlock,
		clearLocalData() {
			return workspace.clearLocalData();
		},
	};
}

function toAuthResult(
	data: { user: User } & Partial<CustomSessionFields>,
	token: string | null | undefined,
): AuthResult {
	return {
		user: toStoredUser(data.user),
		token: token ?? null,
		userKeyBase64: data.encryptionKey ?? null,
	};
}

function toStoredUser(raw: User): StoredUser {
	return {
		id: raw.id,
		createdAt: raw.createdAt.toISOString(),
		updatedAt: raw.updatedAt.toISOString(),
		email: raw.email,
		emailVerified: raw.emailVerified,
		name: raw.name,
		image: raw.image,
	};
}

function getErrorStatus(error: WorkspaceAuthError | unknown) {
	if (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
	) {
		return error.status;
	}
	return undefined;
}

function isAuthRejection(error: WorkspaceAuthError) {
	const status = getErrorStatus(error);
	return status !== undefined && status < 500;
}

function isCancelledError(cause: unknown) {
	const message = cause instanceof Error ? cause.message : '';
	return message.includes('canceled') || message.includes('cancelled');
}
