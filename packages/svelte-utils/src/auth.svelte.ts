import type {
	WorkspaceEncryption,
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
	get(): T;
	set(value: T): void | Promise<void>;
	watch?: (callback: (value: T) => void) => (() => void) | undefined;
	whenReady?: Promise<void>;
};

type WorkspaceSessionHandle = {
	clearLocalData(): Promise<void>;
	encryption: WorkspaceEncryption | WorkspaceEncryptionWithCache;
};

function hasTryUnlock(
	encryption: WorkspaceEncryption | WorkspaceEncryptionWithCache,
): encryption is WorkspaceEncryptionWithCache {
	return 'tryUnlock' in encryption;
}

export function createAuth({
	baseURL,
	token,
	user,
	workspace,
	signInWithGoogle,
}: {
	baseURL: string | (() => string);
	token: SessionField<string | null>;
	user: SessionField<StoredUser | null>;
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
	let hasExternalSession = $state(Boolean(user.get()));
	let isApplyingLocalSessionChange = false;
	let bootstrapPromise: Promise<StoredUser | null> | null = null;
	let lastPublishedToken = token.get();
	const tokenListeners = new Set<(token: string | null) => void>();

	function notifyTokenChange() {
		const nextToken = token.get();
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
		return user.get() ? 'signed-in' : 'signed-out';
	}

	function getState(): AuthState {
		const status = getStatus();
		return {
			status,
			user: user.get(),
			token: token.get(),
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
			hasExternalSession = Boolean(user.get());
			notifyTokenChange();
		}
	}

	async function writeAuthenticatedSession(next: {
		user: StoredUser;
		token: string | null;
		userKeyBase64: string | null;
	}) {
		if (!next.userKeyBase64) {
			return new Error('Authenticated session is missing userKeyBase64');
		}

		await workspace.encryption.unlock(base64ToBytes(next.userKeyBase64));

		await applyLocalSessionChange(async () => {
			await token.set(next.token);
			await user.set(next.user);
		});
		setLastError(undefined);
		return null;
	}

	async function clearSession() {
		await workspace.clearLocalData();
		await applyLocalSessionChange(async () => {
			await token.set(null);
			await user.set(null);
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
				await Promise.all([token.whenReady, user.whenReady].filter(Boolean));

				if (user.get() && hasTryUnlock(workspace.encryption)) {
					await workspace.encryption.tryUnlock();
					setLastError(undefined);
				}

				setPendingAction(null);
				return user.get();
			})();
		}

		return await bootstrapPromise;
	}

	async function refreshSession() {
		await waitUntilReady();
		setPendingAction('checking');

		try {
			const { client, getIssuedToken } = buildClient(token.get());
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
				return user.get();
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
			return user.get();
		}

		setPendingAction(null);
		return user.get();
	}

	const handleExternalSessionChange = () => {
		if (isApplyingLocalSessionChange) return;

		const wasSignedIn = hasExternalSession;
		const isSignedIn = Boolean(user.get());
		hasExternalSession = isSignedIn;

		setPendingAction(null);

		if (!isSignedIn && wasSignedIn) {
			setLastError(undefined);
			void tryAsync({
				try: () => workspace.clearLocalData(),
				catch: () => Ok(undefined),
			});
		} else if (isSignedIn && !wasSignedIn && hasTryUnlock(workspace.encryption)) {
			const encryption = workspace.encryption;
			setLastError(undefined);
			void tryAsync({
				try: () => encryption.tryUnlock(),
				catch: () => Ok(false),
			});
		}

		notifyTokenChange();
	};

	token.watch?.(handleExternalSessionChange);
	user.watch?.(handleExternalSessionChange);

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
			return user.get();
		},

		get token() {
			return token.get();
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
			const authToken = token.get();
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
				const { client } = buildClient(token.get());
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
