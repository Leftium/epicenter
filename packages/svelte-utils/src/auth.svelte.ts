import type {
	WorkspaceEncryptionWithCache,
} from '@epicenter/workspace';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { type } from 'arktype';
import type { User } from 'better-auth';
import { createAuthClient } from 'better-auth/client';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';

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

export const PersistedSession = type({
	status: "'anonymous'",
}).or({
	status: "'authenticated'",
	token: 'string',
	user: StoredUser,
});

export type PersistedSession = typeof PersistedSession.infer;

export type AuthStatus =
	| 'bootstrapping'
	| 'checking'
	| 'signing-in'
	| 'signing-out'
	| 'signed-in'
	| 'signed-out';

export type AuthState = {
	status: AuthStatus;
	user: StoredUser | null;
	token: string | null;
	signInError?: string;
};

export type Auth = {
	readonly whenReady: Promise<StoredUser | null>;
	readonly state: AuthState;
	readonly status: AuthStatus;
	readonly user: StoredUser | null;
	readonly token: string | null;
	readonly signInError?: string;
	onTokenChange(listener: (token: string | null) => void): () => void;
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

export type SessionField<T> = {
	readonly current: T;
	set(value: T): void | Promise<void>;
	watch(callback: (value: T) => void): (() => void) | undefined;
	whenReady?: Promise<void>;
};

type WorkspaceSessionHandle = {
	clearLocalData(): Promise<void>;
	encryption: WorkspaceEncryptionWithCache;
};

export function createAuth({
	baseURL,
	session,
	workspace,
	signInWithGoogle,
}: {
	baseURL: string | (() => string);
	session: SessionField<PersistedSession>;
	workspace: WorkspaceSessionHandle;
	signInWithGoogle?: (
		client: ReturnType<typeof createAuthClient>,
	) => Promise<{ user: User } & { encryptionKey?: string | null }>;
}): Auth {
	const resolveBaseUrl =
		typeof baseURL === 'function' ? baseURL : () => baseURL;

	let pendingAction = $state<Exclude<AuthStatus, 'signed-in' | 'signed-out'> | null>(
		'bootstrapping',
	);
	let lastError = $state<string | undefined>(undefined);
	let hasExternalSession = $state(session.current.status === 'authenticated');
	let isApplyingLocalSessionChange = false;
	let bootstrapPromise: Promise<StoredUser | null> | null = null;
	let lastPublishedToken =
		session.current.status === 'authenticated' ? session.current.token : null;
	const tokenListeners = new Set<(token: string | null) => void>();

	function notifyTokenChange() {
		const nextToken =
			session.current.status === 'authenticated' ? session.current.token : null;
		if (nextToken === lastPublishedToken) return;
		lastPublishedToken = nextToken;
		for (const listener of tokenListeners) {
			listener(nextToken);
		}
	}

	function buildClient(authToken: string | null) {
		let issuedToken: string | null | undefined;

		const client = createAuthClient({
			baseURL: resolveBaseUrl(),
			basePath: '/auth',
			fetchOptions: {
				auth: {
					type: 'Bearer',
					token: () => authToken ?? undefined,
				},
				onSuccess: ({ response }) => {
					const nextToken = response.headers.get('set-auth-token');
					if (nextToken) issuedToken = nextToken;
				},
			},
		});

		return {
			client,
			getIssuedToken: () => issuedToken ?? authToken ?? null,
		};
	}

	function getStatus(): AuthStatus {
		if (pendingAction) return pendingAction;
		return session.current.status === 'authenticated'
			? 'signed-in'
			: 'signed-out';
	}

	function getState(): AuthState {
		const status = getStatus();
		const currentSession = session.current;
		return {
			status,
			user: currentSession.status === 'authenticated' ? currentSession.user : null,
			token:
				currentSession.status === 'authenticated'
					? currentSession.token
					: null,
			signInError: status === 'signed-out' ? lastError : undefined,
		};
	}

	function setPendingAction(
		next: Exclude<AuthStatus, 'signed-in' | 'signed-out'> | null,
	) {
		if (pendingAction === next) return;
		pendingAction = next;
	}

	function setLastError(next: string | undefined) {
		if (lastError === next) return;
		lastError = next;
	}

	async function applyLocalSessionChange(run: () => void | Promise<void>) {
		isApplyingLocalSessionChange = true;
		try {
			await run();
		} finally {
			isApplyingLocalSessionChange = false;
			hasExternalSession = session.current.status === 'authenticated';
			notifyTokenChange();
		}
	}

	async function writeAuthenticatedSession(next: {
		user: StoredUser;
		token: string | null;
		userKeyBase64: string | null;
	}) {
		if (!next.token) {
			return new Error('Authenticated session is missing bearer token');
		}
		const token = next.token;

		if (!next.userKeyBase64) {
			return new Error('Authenticated session is missing userKeyBase64');
		}

		await workspace.encryption.unlock(base64ToBytes(next.userKeyBase64));

		await applyLocalSessionChange(async () => {
			await session.set({
				status: 'authenticated',
				token,
				user: next.user,
			});
		});
		setLastError(undefined);
		return null;
	}

	async function clearSession() {
		await workspace.clearLocalData();
		await applyLocalSessionChange(async () => {
			await session.set({ status: 'anonymous' });
		});
		setLastError(undefined);
	}

	async function authenticate(
		run: () => Promise<
			| {
					user: StoredUser;
					token: string | null;
					userKeyBase64: string | null;
			  }
			| null
		>,
	) {
		setPendingAction('signing-in');

		try {
			const nextSession = await run();
			if (!nextSession) {
				setPendingAction(null);
				return;
			}

			const writeError = await writeAuthenticatedSession(nextSession);
			if (writeError) {
				setLastError(writeError.message);
			}
		} catch (error) {
			setLastError(
				(error instanceof Error
					? error.message.includes('canceled') ||
						error.message.includes('cancelled')
					: false)
					? undefined
					: extractErrorMessage(error),
			);
		}

		setPendingAction(null);
	}

	async function waitUntilReady() {
		if (!bootstrapPromise) {
			bootstrapPromise = (async () => {
				await Promise.all([session.whenReady].filter(Boolean));

				if (session.current.status === 'authenticated') {
					await workspace.encryption.tryUnlock();
					setLastError(undefined);
				}

				setPendingAction(null);
				return session.current.status === 'authenticated'
					? session.current.user
					: null;
			})();
		}

		return await bootstrapPromise;
	}

	async function refreshSession() {
		await waitUntilReady();
		setPendingAction('checking');

		try {
			const { client, getIssuedToken } = buildClient(
				session.current.status === 'authenticated'
					? session.current.token
					: null,
			);
			const { data, error } = await client.getSession();

			if (error) {
				const status =
					typeof error === 'object' &&
					error !== null &&
					'status' in error &&
					typeof error.status === 'number'
						? error.status
						: undefined;
				if (status !== undefined && status < 500) {
					await clearSession();
					setPendingAction(null);
					return null;
				}

				setPendingAction(null);
				return session.current.status === 'authenticated'
					? session.current.user
					: null;
			}

			if (!data) {
				await clearSession();
				setPendingAction(null);
				return null;
			}

			const writeError = await writeAuthenticatedSession({
				user: toStoredUser(data.user),
				token: getIssuedToken(),
				userKeyBase64:
					(data as typeof data & { encryptionKey?: string | null })
						.encryptionKey ?? null,
			});
			if (writeError) {
				await clearSession();
				setLastError(`Session refresh failed: ${writeError.message}`);
				setPendingAction(null);
				return null;
			}
		} catch {
			setPendingAction(null);
			return session.current.status === 'authenticated'
				? session.current.user
				: null;
		}

		setPendingAction(null);
		return session.current.status === 'authenticated'
			? session.current.user
			: null;
	}

	const handleExternalSessionChange = () => {
		if (isApplyingLocalSessionChange) return;

		const wasSignedIn = hasExternalSession;
		const isSignedIn = session.current.status === 'authenticated';
		hasExternalSession = isSignedIn;

		setPendingAction(null);

		if (!isSignedIn && wasSignedIn) {
			setLastError(undefined);
			void tryAsync({
				try: () => workspace.clearLocalData(),
				catch: () => Ok(undefined),
			});
		} else if (isSignedIn && !wasSignedIn) {
			setLastError(undefined);
			void tryAsync({
				try: () => workspace.encryption.tryUnlock(),
				catch: () => Ok(false),
			});
		}

		notifyTokenChange();
	};

	session.watch(handleExternalSessionChange);

	return {
		get whenReady() {
			return waitUntilReady();
		},

		get state() {
			return getState();
		},

		get status() {
			return getStatus();
		},

		get user() {
			return session.current.status === 'authenticated'
				? session.current.user
				: null;
		},

		get token() {
			return session.current.status === 'authenticated'
				? session.current.token
				: null;
		},

		get signInError() {
			return getState().signInError;
		},

		onTokenChange(listener) {
			tokenListeners.add(listener);
			return () => {
				tokenListeners.delete(listener);
			};
		},

		refreshSession,

		fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const authToken =
				session.current.status === 'authenticated'
					? session.current.token
					: null;
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
			await authenticate(async () => {
				const { client, getIssuedToken } = buildClient(null);
				const { data, error } = await client.signIn.email(credentials);
				if (error) {
					throw new Error(`Sign-in failed: ${extractErrorMessage(error)}`);
				}

				return {
					user: toStoredUser(data.user),
					token: getIssuedToken(),
					userKeyBase64:
						(data as typeof data & { encryptionKey?: string | null })
							.encryptionKey ?? null,
				};
			});
		},

		async signUp(credentials) {
			await authenticate(async () => {
				const { client, getIssuedToken } = buildClient(null);
				const { data, error } = await client.signUp.email(credentials);
				if (error) {
					throw new Error(`Sign-up failed: ${extractErrorMessage(error)}`);
				}

				return {
					user: toStoredUser(data.user),
					token: getIssuedToken(),
					userKeyBase64:
						(data as typeof data & { encryptionKey?: string | null })
							.encryptionKey ?? null,
				};
			});
		},

		async signInWithGoogle() {
			await authenticate(async () => {
				const { client, getIssuedToken } = buildClient(null);

				if (signInWithGoogle) {
					const data = await signInWithGoogle(client);
					return {
						user: toStoredUser(data.user),
						token: getIssuedToken(),
						userKeyBase64: data.encryptionKey ?? null,
					};
				}

				await client.signIn.social({
					provider: 'google',
					callbackURL: window.location.origin,
				});
				return null;
			});
		},

		async signOut() {
			setPendingAction('signing-out');

			try {
				const { client } = buildClient(
					session.current.status === 'authenticated'
						? session.current.token
						: null,
				);
				const { error } = await client.signOut();
				if (error) {
					throw new Error(`Sign-out failed: ${extractErrorMessage(error)}`);
				}
			} catch {}

			await clearSession();
			setPendingAction(null);
		},
	};
}

function toStoredUser(user: User): StoredUser {
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
