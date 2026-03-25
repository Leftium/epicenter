/**
 * Auth primitives for Epicenter Svelte apps.
 *
 * Four public constructors cover all current use cases:
 *
 * - {@link createAuth} — default SPA auth with localStorage and Better Auth
 *   web redirect. Use this for apps like Zhongwen that only need session state.
 *
 * - {@link createWorkspaceAuth} — default SPA auth with encrypted workspace
 *   lifecycle. Use this for apps like Honeycrisp and Opensidian where
 *   signed-in implies a decrypted workspace.
 *
 * - {@link createAuthWith} — custom auth with an injected client and store.
 *   Use this when the default localStorage or Better Auth redirect setup
 *   does not fit your environment.
 *
 * - {@link createWorkspaceAuthWith} — custom auth with injected client,
 *   store, and workspace lifecycle. Use this for environments like Chrome
 *   extensions that need custom OAuth flows, custom storage backends, and
 *   encrypted workspace teardown.
 *
 * Most apps should use `createAuth` or `createWorkspaceAuth`. The `*With`
 * variants exist for the Chrome extension and any future outlier.
 */

import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { type } from 'arktype';
import type { User } from 'better-auth';
import { createAuthClient } from 'better-auth/client';
import { extractErrorMessage } from 'wellcrafted/error';
import { createPersistedState } from './persisted-state.svelte';

// ─── Shared types ───────────────────────────────────────────────────────────

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

type BetterAuthInternalClient = ReturnType<typeof createAuthClient>;

class AuthFlowInterrupt extends Error {
	kind: 'redirect';

	constructor(kind: 'redirect') {
		super('Redirect started');
		this.kind = kind;
	}
}

// ─── Auth stores ────────────────────────────────────────────────────────────

function createLocalAuthStore(prefix: string): AuthStore {
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
 * Adapter from reactive token/user cells to {@link AuthStore}.
 *
 * Use this for environments like Chrome extensions that already have reactive
 * storage wrappers (e.g. `createStorageState()`). If the cells expose
 * `watch()`, the returned store forwards changes through `subscribe()` so
 * the auth state can react to sign-in/sign-out from other extension contexts.
 */
export function createCellAuthStore({
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

// ─── Better Auth client ─────────────────────────────────────────────────────

function createWebAuthClient(baseURL: string | (() => string)): AuthClient {
	return createBetterAuthClient({
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
 * Create an {@link AuthClient} backed by Better Auth.
 *
 * Most apps should use {@link createAuth} or {@link createWorkspaceAuth},
 * which build this client internally. This lower-level constructor exists
 * for environments like the Chrome extension where Google sign-in uses a
 * popup flow instead of a redirect.
 */
export function createBetterAuthClient({
	baseURL,
	signInWithGoogle,
}: {
	baseURL: string | (() => string);
	signInWithGoogle: (
		client: BetterAuthInternalClient,
	) => Promise<{ user: User }>;
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

// ─── Public constructors ────────────────────────────────────────────────────

type CreateAuthOptions = {
	baseURL: string | (() => string);
	storageKey: string;
};

/**
 * Default SPA auth with localStorage and Better Auth web redirect.
 *
 * This is the simplest entry point. It creates a Better Auth client that uses
 * Google redirect sign-in and a localStorage-backed session store. Use this
 * for apps that only need session state without workspace decryption.
 *
 * @example
 * ```typescript
 * import { createAuth } from '@epicenter/svelte/auth-state';
 *
 * export const auth = createAuth({
 *   baseURL: 'https://api.example.com',
 *   storageKey: 'myapp',
 * });
 * ```
 */
export function createAuth({ baseURL, storageKey }: CreateAuthOptions) {
	return createAuthWith({
		client: createWebAuthClient(baseURL),
		store: createLocalAuthStore(storageKey),
	});
}

/**
 * Default SPA auth with encrypted workspace lifecycle.
 *
 * Like {@link createAuth}, this creates a Better Auth client and localStorage
 * store internally. It additionally ties the auth lifecycle to a workspace:
 * signing in activates encryption, signing out deactivates it.
 *
 * Use this for apps where signed-in means the workspace must be decrypted
 * and usable.
 *
 * @example
 * ```typescript
 * import { createWorkspaceAuth } from '@epicenter/svelte/auth-state';
 *
 * export const auth = createWorkspaceAuth({
 *   baseURL: 'https://api.example.com',
 *   storageKey: 'myapp',
 *   workspace,
 * });
 * ```
 */
export function createWorkspaceAuth({
	baseURL,
	storageKey,
	workspace,
}: CreateAuthOptions & { workspace: WorkspaceHandle }) {
	return createWorkspaceAuthWith({
		client: createWebAuthClient(baseURL),
		store: createLocalAuthStore(storageKey),
		workspace,
	});
}

/**
 * Custom auth with an injected client and store.
 *
 * Use this when the default localStorage or Better Auth redirect setup does
 * not fit your environment. You provide the {@link AuthClient} and
 * {@link AuthStore} implementations; this constructor builds the reactive
 * auth state machine on top of them.
 *
 * @example
 * ```typescript
 * import { createAuthWith, createBetterAuthClient, createCellAuthStore } from '@epicenter/svelte/auth-state';
 *
 * export const auth = createAuthWith({
 *   client: createBetterAuthClient({ baseURL, signInWithGoogle: customFlow }),
 *   store: createCellAuthStore({ token: myTokenCell, user: myUserCell }),
 * });
 * ```
 */
export function createAuthWith({
	client,
	store,
}: {
	client: AuthClient;
	store: AuthStore;
}) {
	return buildAuthState(client, store, {});
}

/**
 * Custom auth with injected client, store, and workspace lifecycle.
 *
 * Like {@link createAuthWith}, but ties the auth lifecycle to a workspace.
 * Signing in activates encryption, signing out deactivates it. An optional
 * `restoreUserKey` callback lets `checkSession()` restore a cached encryption
 * key before the server roundtrip so the workspace is usable immediately.
 *
 * Use this for environments like Chrome extensions that need custom OAuth
 * flows, custom storage backends, and encrypted workspace teardown.
 *
 * @example
 * ```typescript
 * import { createWorkspaceAuthWith, createBetterAuthClient, createCellAuthStore } from '@epicenter/svelte/auth-state';
 *
 * export const auth = createWorkspaceAuthWith({
 *   client: createBetterAuthClient({ baseURL, signInWithGoogle: customFlow }),
 *   store: createCellAuthStore({ token: myTokenCell, user: myUserCell }),
 *   workspace,
 *   restoreUserKey: async () => loadCachedKey(),
 * });
 * ```
 */
export function createWorkspaceAuthWith({
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
	return buildAuthState(client, store, {
		async beforeCheckSession(snapshot) {
			if (!snapshot.user || !restoreUserKey) return;
			const cachedKey = await restoreUserKey();
			if (cachedKey) {
				await workspace.activateEncryption(cachedKey);
			}
		},
		async onAuthenticated(result) {
			if (!result.encryptionKey) return;
			await workspace.activateEncryption(base64ToBytes(result.encryptionKey));
		},
		async onSignedOut() {
			await workspace.deactivateEncryption();
		},
		async onExternalSignedIn(snapshot) {
			if (!snapshot.user || !restoreUserKey) return;
			const cachedKey = await restoreUserKey();
			if (cachedKey) {
				await workspace.activateEncryption(cachedKey);
			}
		},
	});
}

// ─── Internal state machine ─────────────────────────────────────────────────

type AuthLifecycle = {
	beforeCheckSession?: (snapshot: SessionSnapshot) => Promise<void>;
	onAuthenticated?: (result: AuthResult) => Promise<void>;
	onSignedOut?: () => Promise<void>;
	onExternalSignedIn?: (snapshot: SessionSnapshot) => Promise<void>;
};

function buildAuthState(
	client: AuthClient,
	store: AuthStore,
	lifecycle: AuthLifecycle,
) {
	let pendingAction = $state<'checking' | 'signing-in' | 'signing-out' | null>(
		store.read().user ? null : 'checking',
	);
	let lastError = $state<string | undefined>(undefined);
	let hasExternalSession = $state(Boolean(store.read().user));

	function getStatus(): AuthStatus {
		if (pendingAction) return pendingAction;
		return store.read().user ? 'signed-in' : 'signed-out';
	}

	async function writeAuthenticatedResult(result: AuthResult) {
		await store.write({ user: result.user, token: result.token });
		await lifecycle.onAuthenticated?.(result);
		lastError = undefined;
	}

	async function clearSession() {
		await store.clear();
		await lifecycle.onSignedOut?.();
	}

	async function authenticate(
		run: () => Promise<AuthResult>,
		errorPrefix: string,
	) {
		pendingAction = 'signing-in';

		try {
			const result = await run();
			await writeAuthenticatedResult(result);
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

		if (!isSignedIn) {
			void lifecycle.onSignedOut?.();
			pendingAction = null;
			return;
		}

		pendingAction = null;
		void lifecycle.onExternalSignedIn?.(snapshot);
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
		 * On success the store is updated and workspace auth activates
		 * encryption automatically.
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
		 * Workspace auth also deactivates encryption.
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
			await lifecycle.beforeCheckSession?.(snapshot);

			try {
				const result = await client.getSession(snapshot.token);

				if (!result) {
					await clearSession();
					pendingAction = null;
					return null;
				}

				await writeAuthenticatedResult(result);
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
