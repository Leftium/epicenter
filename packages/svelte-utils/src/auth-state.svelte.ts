/**
 * Auth primitives for Epicenter Svelte apps.
 *
 * Public auth stays split by domain:
 *
 * - {@link createAuth} manages signed-in versus signed-out session state.
 * - {@link createWorkspaceAuth} adds the encrypted workspace lifecycle for
 *   products where signed-in means the workspace must already be decrypted.
 *
 * Platform differences stay below that surface:
 *
 * - {@link createWebAuthClient} uses Better Auth's normal web redirect flow.
 * - {@link createExtensionAuthClient} adapts extension-specific Google OAuth.
 * - {@link createLocalAuthStore} persists auth in localStorage-backed state.
 * - {@link createChromeAuthStore} adapts reactive extension storage cells.
 */

import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { type } from 'arktype';
import type { User } from 'better-auth';
import { createAuthClient } from 'better-auth/client';
import { extractErrorMessage } from 'wellcrafted/error';
import { createPersistedState } from './persisted-state.svelte';

/**
 * Custom session fields added by the server's Better Auth `customSession`
 * plugin. Workspace apps use the server-provided encryption key to decrypt
 * local data after sign-in or session restore.
 */
type CustomSessionFields = {
	encryptionKey: string;
};

/**
 * Runtime schema and TypeScript type for the cached auth user.
 *
 * The store layer validates persisted users with this schema before exposing
 * them to the rest of the app.
 */
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
	| 'checking'
	| 'signing-in'
	| 'signing-out'
	| 'signed-in'
	| 'signed-out';

/**
 * Persisted session snapshot.
 *
 * The token is optional at the product level. Cookie-backed flows such as
 * Zhongwen's OAuth redirect may have a valid server session before a bearer
 * token has been rehydrated locally.
 */
export type SessionSnapshot = {
	token: string | null;
	user: StoredUser | null;
};

/**
 * Flat auth result from client operations.
 *
 * `user` and `token` are always present; `encryptionKey` is only set by
 * workspace-aware servers that include it in the custom session response.
 */
export type AuthResult = {
	user: StoredUser;
	token: string | null;
	encryptionKey?: string | null;
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

/**
 * Auth client boundary.
 *
 * Normalizes auth I/O into flat {@link AuthResult} values. The auth state
 * constructors own persistence and phase transitions; the client only
 * performs network requests.
 */
export type AuthClient = {
	signIn(credentials: EmailSignInCredentials): Promise<AuthResult>;
	signUp(credentials: EmailSignUpCredentials): Promise<AuthResult>;
	signInWithGoogle(): Promise<AuthResult>;
	signOut(token: string | null): Promise<void>;
	getSession(token: string | null): Promise<AuthResult | null>;
};

/**
 * Auth store boundary.
 *
 * Reads and writes complete session snapshots. Stores may expose
 * `subscribe()` for cross-context sync such as `chrome.storage`.
 */
export type AuthStore = {
	ready: Promise<void>;
	read(): SessionSnapshot;
	write(snapshot: SessionSnapshot): void | Promise<void>;
	clear(): void | Promise<void>;
	subscribe?(
		listener: (snapshot: SessionSnapshot) => void,
	): (() => void) | undefined;
};

type WorkspaceHandle = {
	activateEncryption: (userKey: Uint8Array) => Promise<void>;
	deactivateEncryption: () => Promise<void>;
};

type ReactiveCell<T> = {
	current: T;
	set?: (value: T) => Promise<void>;
	watch?: (callback: (value: T) => void) => (() => void) | undefined;
	whenReady?: Promise<void>;
};

type TransportError = Error & {
	status?: number;
};

type PendingAction = 'checking' | 'signing-in' | 'signing-out' | null;

type BetterAuthInternalClient = ReturnType<typeof createAuthClient>;

class AuthFlowInterrupt extends Error {
	kind: 'redirect';

	constructor(kind: 'redirect') {
		super('Redirect started');
		this.kind = kind;
	}
}

/**
 * localStorage-backed auth store for normal web apps.
 *
 * Use this for apps that persist auth in the browser and do not need
 * cross-context storage events beyond what Svelte already reads locally.
 */
export function createLocalAuthStore(prefix: string): AuthStore {
	const tokenState = createPersistedState({
		key: `${prefix}:authToken`,
		schema: type('string').or('null'),
		defaultValue: null,
	});
	const userState = createPersistedState({
		key: `${prefix}:authUser`,
		schema: StoredUser.or('null'),
		defaultValue: null,
	});

	return {
		ready: Promise.resolve(),
		read: () => ({
			token: tokenState.current,
			user: userState.current,
		}),
		write(snapshot) {
			tokenState.current = snapshot.token;
			userState.current = snapshot.user;
		},
		clear() {
			tokenState.current = null;
			userState.current = null;
		},
	};
}

/**
 * Chrome extension auth store backed by reactive storage cells.
 *
 * Use this when auth lives in `chrome.storage` wrappers that already expose
 * synchronous `.current` access plus async persistence and watch hooks.
 */
export function createChromeAuthStore({
	token,
	user,
	ready,
}: {
	token: ReactiveCell<string | null>;
	user: ReactiveCell<StoredUser | null>;
	ready?: Promise<void>;
}): AuthStore {
	const resolvedReady = (ready ??
		Promise.all([token.whenReady, user.whenReady].filter(Boolean)).then(
			() => undefined,
		)) as Promise<void>;

	async function writeCell<T>(cell: ReactiveCell<T>, value: T) {
		if (cell.set) {
			await cell.set(value);
			return;
		}
		cell.current = value;
	}

	return {
		ready: resolvedReady,
		read: () => ({
			token: token.current,
			user: user.current,
		}),
		async write(snapshot) {
			await writeCell(token, snapshot.token);
			await writeCell(user, snapshot.user);
		},
		async clear() {
			await writeCell(token, null);
			await writeCell(user, null);
		},
		subscribe(listener) {
			const notify = () => {
				listener({
					token: token.current,
					user: user.current,
				});
			};
			const unsubscribeToken = token.watch?.(() => {
				notify();
			});
			const unsubscribeUser = user.watch?.(() => {
				notify();
			});
			return () => {
				unsubscribeToken?.();
				unsubscribeUser?.();
			};
		},
	};
}

/**
 * Better Auth client for normal web redirects.
 *
 * `signInWithGoogle()` starts the provider redirect and intentionally
 * interrupts the local auth flow without treating the redirect as an error.
 */
export function createWebAuthClient({
	baseURL,
}: {
	baseURL: string | (() => string);
}): AuthClient {
	return createBetterAuthBoundary({
		baseURL,
		signInWithGoogle: async (client) => {
			await client.signIn.social({
				provider: 'google',
				callbackURL: window.location.origin,
			});
			throw new AuthFlowInterrupt('redirect');
		},
	});
}

/**
 * Better Auth client for Chrome-extension-style Google OAuth flows.
 *
 * The extension owns how the popup or identity API works. This helper only
 * adapts that platform-specific sign-in mechanism to the shared
 * {@link AuthClient} contract.
 */
export function createExtensionAuthClient({
	baseURL,
	signInWithGoogle,
}: {
	baseURL: string | (() => string);
	signInWithGoogle: (
		client: BetterAuthInternalClient,
	) => Promise<{ user: User } & Partial<CustomSessionFields>>;
}): AuthClient {
	return createBetterAuthBoundary({
		baseURL,
		signInWithGoogle,
	});
}

function createBetterAuthBoundary({
	baseURL,
	signInWithGoogle,
}: {
	baseURL: string | (() => string);
	signInWithGoogle: (
		client: BetterAuthInternalClient,
	) => Promise<{ user: User } & Partial<CustomSessionFields>>;
}): AuthClient {
	const resolveBaseURL =
		typeof baseURL === 'function' ? baseURL : () => baseURL;

	function buildClient(token: string | null) {
		let nextToken: string | null | undefined;

		const client = createAuthClient({
			baseURL: resolveBaseURL(),
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

	return {
		async signIn(credentials) {
			const { client, getIssuedToken } = buildClient(null);
			const { data, error } = await client.signIn.email(credentials);
			if (error) throw toTransportError(error);
			return toAuthResult(data, getIssuedToken());
		},

		async signUp(credentials) {
			const { client, getIssuedToken } = buildClient(null);
			const { data, error } = await client.signUp.email(credentials);
			if (error) throw toTransportError(error);
			return toAuthResult(data, getIssuedToken());
		},

		async signInWithGoogle() {
			const { client, getIssuedToken } = buildClient(null);
			const data = await signInWithGoogle(client);
			return toAuthResult(data, getIssuedToken());
		},

		async signOut(token) {
			const { client } = buildClient(token);
			const { error } = await client.signOut();
			if (error) throw toTransportError(error);
		},

		async getSession(token) {
			const { client, getIssuedToken } = buildClient(token);
			const { data, error } = await client.getSession();
			if (error) throw toTransportError(error);
			if (!data) return null;

			const customData = data as typeof data & Partial<CustomSessionFields>;
			return {
				user: toStoredUser(customData.user),
				token: getIssuedToken() ?? token,
				encryptionKey: customData.encryptionKey ?? null,
			};
		},
	};
}

/**
 * Plain auth state.
 *
 * Use this for products like Zhongwen that only need auth persistence and an
 * authenticated fetch wrapper. Platform-specific behavior belongs in the
 * injected `client` and `store`.
 *
 * @example
 * ```typescript
 * export const authState = createAuth({
 *   client: createWebAuthClient({ baseURL: APP_URLS.API }),
 *   store: createLocalAuthStore('zhongwen'),
 * });
 * ```
 */
export function createAuth({
	client,
	store,
}: {
	client: AuthClient;
	store: AuthStore;
}) {
	let pendingAction = $state<PendingAction>(
		store.read().user ? null : 'checking',
	);
	let lastError = $state<string | undefined>(undefined);
	let hasExternalSession = $state(Boolean(store.read().user));

	function getStatus(): AuthStatus {
		if (pendingAction) return pendingAction;
		return store.read().user ? 'signed-in' : 'signed-out';
	}

	async function writeAuthenticatedSession(result: AuthResult) {
		await store.write({ user: result.user, token: result.token });
		lastError = undefined;
	}

	async function clearSession() {
		await store.clear();
	}

	async function authenticate(
		run: () => Promise<AuthResult>,
		errorPrefix: string,
	) {
		pendingAction = 'signing-in';

		try {
			const result = await run();
			await writeAuthenticatedSession(result);
			pendingAction = null;
			return;
		} catch (cause) {
			if (isRedirectInterrupt(cause)) {
				pendingAction = null;
				return;
			}
			lastError = isCancelledError(cause)
				? undefined
				: `${errorPrefix}: ${extractErrorMessage(cause)}`;
			pendingAction = null;
		}
	}

	store.subscribe?.((snapshot) => {
		const isSignedIn = Boolean(snapshot.user);
		if (isSignedIn === hasExternalSession) return;
		hasExternalSession = isSignedIn;
		pendingAction = null;
		if (isSignedIn) lastError = undefined;
	});

	return {
		get status() {
			return getStatus();
		},

		get signInError() {
			return getStatus() === 'signed-out' ? lastError : undefined;
		},

		get user() {
			return store.read().user;
		},

		get token() {
			return store.read().token;
		},

		/**
		 * Auth-aware fetch wrapper.
		 *
		 * Sends `credentials: 'include'` so cookie-backed auth flows continue
		 * to work, and adds `Authorization: Bearer <token>` when the store has
		 * a token.
		 */
		fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const token = store.read().token;
			if (token) {
				headers.set('Authorization', `Bearer ${token}`);
			}
			return fetch(input, {
				...init,
				headers,
				credentials: 'include',
			});
		}) as typeof fetch,

		/**
		 * Sign in with email and password.
		 *
		 * On success the store is updated and the auth state becomes
		 * `signed-in`.
		 */
		async signIn(credentials: EmailSignInCredentials) {
			await authenticate(() => client.signIn(credentials), 'Sign-in failed');
		},

		/**
		 * Create an account with email, password, and name.
		 *
		 * Treated as a session-producing auth action with the same persistence
		 * and error behavior as sign-in.
		 */
		async signUp(credentials: EmailSignUpCredentials) {
			await authenticate(() => client.signUp(credentials), 'Sign-up failed');
		},

		/**
		 * Start the Google sign-in flow.
		 *
		 * Web clients redirect the page; extension clients complete in-place
		 * and return a session result.
		 */
		async signInWithGoogle() {
			await authenticate(
				() => client.signInWithGoogle(),
				'Google sign-in failed',
			);
		},

		/**
		 * Sign out locally and on the server.
		 *
		 * The local session is always cleared even if the server call fails.
		 */
		async signOut() {
			pendingAction = 'signing-out';
			try {
				await client.signOut(store.read().token);
			} catch {}
			await clearSession();
			pendingAction = null;
		},

		/**
		 * Validate the current session against the server.
		 *
		 * Does not require a local bearer token—cookie-backed flows may have
		 * a valid server session even when the local token is missing.
		 *
		 * Unreachable server responses keep cached state so offline users are
		 * not logged out. Explicit auth rejections (4xx) clear the store.
		 */
		async checkSession() {
			await store.ready;
			pendingAction = 'checking';

			const snapshot = store.read();

			try {
				const result = await client.getSession(snapshot.token);

				if (!result) {
					await clearSession();
					pendingAction = null;
					return null;
				}

				await writeAuthenticatedSession(result);
				pendingAction = null;
				return result.user;
			} catch (cause) {
				const error = toTransportError(cause);
				const isAuthRejection =
					error.status !== undefined && error.status < 500;

				if (isAuthRejection) {
					await clearSession();
					pendingAction = null;
					return null;
				}

				const cachedUser = store.read().user;
				pendingAction = null;
				return cachedUser;
			}
		},
	};
}

/**
 * Workspace-coupled auth state.
 *
 * Use this for products where a signed-in user implies an active decrypted
 * workspace. The injected auth `client` and `store` still handle platform
 * differences; this constructor owns the workspace activation and teardown
 * rules on top.
 *
 * @example
 * ```typescript
 * export const authState = createWorkspaceAuth({
 *   client: createWebAuthClient({ baseURL: APP_URLS.API }),
 *   store: createLocalAuthStore('honeycrisp'),
 *   workspace,
 * });
 * ```
 */
export function createWorkspaceAuth({
	client,
	store,
	workspace,
	restoreUserKey,
}: {
	client: AuthClient;
	store: AuthStore;
	workspace: WorkspaceHandle;
	restoreUserKey?: () => Promise<Uint8Array | null>;
}) {
	let pendingAction = $state<PendingAction>(
		store.read().user ? null : 'checking',
	);
	let lastError = $state<string | undefined>(undefined);
	let hasExternalSession = $state(Boolean(store.read().user));

	function getStatus(): AuthStatus {
		if (pendingAction) return pendingAction;
		return store.read().user ? 'signed-in' : 'signed-out';
	}

	async function restoreCachedWorkspace(snapshot: SessionSnapshot) {
		if (!snapshot.user || !restoreUserKey) return;
		const cachedKey = await restoreUserKey();
		if (cachedKey) {
			await workspace.activateEncryption(cachedKey);
		}
	}

	async function writeAuthenticatedSession(result: AuthResult) {
		await store.write({ user: result.user, token: result.token });
		if (result.encryptionKey) {
			await workspace.activateEncryption(base64ToBytes(result.encryptionKey));
		}
		lastError = undefined;
	}

	async function clearSession() {
		await store.clear();
		await workspace.deactivateEncryption();
	}

	async function authenticate(
		run: () => Promise<AuthResult>,
		errorPrefix: string,
	) {
		pendingAction = 'signing-in';

		try {
			const result = await run();
			await writeAuthenticatedSession(result);
			pendingAction = null;
			return;
		} catch (cause) {
			if (isRedirectInterrupt(cause)) {
				pendingAction = null;
				return;
			}
			lastError = isCancelledError(cause)
				? undefined
				: `${errorPrefix}: ${extractErrorMessage(cause)}`;
			pendingAction = null;
		}
	}

	store.subscribe?.((snapshot) => {
		const isSignedIn = Boolean(snapshot.user);
		if (isSignedIn === hasExternalSession) return;
		hasExternalSession = isSignedIn;
		pendingAction = null;

		if (!isSignedIn) {
			void workspace.deactivateEncryption();
			return;
		}

		lastError = undefined;
		void restoreCachedWorkspace(snapshot);
	});

	return {
		get status() {
			return getStatus();
		},

		get signInError() {
			return getStatus() === 'signed-out' ? lastError : undefined;
		},

		get user() {
			return store.read().user;
		},

		get token() {
			return store.read().token;
		},

		/**
		 * Auth-aware fetch wrapper.
		 *
		 * Sends `credentials: 'include'` so cookie-backed auth flows continue
		 * to work, and adds `Authorization: Bearer <token>` when the store has
		 * a token.
		 */
		fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const token = store.read().token;
			if (token) {
				headers.set('Authorization', `Bearer ${token}`);
			}
			return fetch(input, {
				...init,
				headers,
				credentials: 'include',
			});
		}) as typeof fetch,

		/**
		 * Sign in with email and password.
		 *
		 * On success the store is updated and workspace encryption activates.
		 */
		async signIn(credentials: EmailSignInCredentials) {
			await authenticate(() => client.signIn(credentials), 'Sign-in failed');
		},

		/**
		 * Create an account with email, password, and name.
		 *
		 * Treated as a session-producing auth action with the same persistence,
		 * error, and workspace rules as sign-in.
		 */
		async signUp(credentials: EmailSignUpCredentials) {
			await authenticate(() => client.signUp(credentials), 'Sign-up failed');
		},

		/**
		 * Start the Google sign-in flow.
		 *
		 * Web clients redirect the page; extension clients complete in-place
		 * and return a session result.
		 */
		async signInWithGoogle() {
			await authenticate(
				() => client.signInWithGoogle(),
				'Google sign-in failed',
			);
		},

		/**
		 * Sign out locally and on the server.
		 *
		 * The local session is always cleared even if the server call fails.
		 * Workspace auth also deactivates encryption and wipes local data.
		 */
		async signOut() {
			pendingAction = 'signing-out';
			try {
				await client.signOut(store.read().token);
			} catch {}
			await clearSession();
			pendingAction = null;
		},

		/**
		 * Validate the current session against the server.
		 *
		 * Does not require a local bearer token—cookie-backed flows may have
		 * a valid server session even when the local token is missing.
		 *
		 * Unreachable server responses keep cached state so offline users are
		 * not logged out. Explicit auth rejections (4xx) clear the store and
		 * tear down the decrypted workspace.
		 */
		async checkSession() {
			await store.ready;
			pendingAction = 'checking';

			const snapshot = store.read();
			await restoreCachedWorkspace(snapshot);

			try {
				const result = await client.getSession(snapshot.token);

				if (!result) {
					await clearSession();
					pendingAction = null;
					return null;
				}

				await writeAuthenticatedSession(result);
				pendingAction = null;
				return result.user;
			} catch (cause) {
				const error = toTransportError(cause);
				const isAuthRejection =
					error.status !== undefined && error.status < 500;

				if (isAuthRejection) {
					await clearSession();
					pendingAction = null;
					return null;
				}

				const cachedUser = store.read().user;
				pendingAction = null;
				return cachedUser;
			}
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
		encryptionKey: data.encryptionKey ?? null,
	};
}

function toTransportError(error: unknown): TransportError {
	const next = new Error(extractErrorMessage(error)) as TransportError;
	if (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		typeof error.status === 'number'
	) {
		next.status = error.status;
	}
	return next;
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

function isCancelledError(cause: unknown) {
	const message = cause instanceof Error ? cause.message : '';
	return message.includes('canceled') || message.includes('cancelled');
}

function isRedirectInterrupt(cause: unknown) {
	return cause instanceof AuthFlowInterrupt && cause.kind === 'redirect';
}
