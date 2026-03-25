/**
 * Layered auth primitives for Epicenter Svelte apps.
 *
 * The public API is split into three layers:
 *
 * - `SessionStore` — persistence and optional cross-context sync
 * - `AuthApi` — Better Auth I/O and provider-specific login flows
 * - auth state controllers:
 *   - `createSessionAuthState()` for generic auth-only apps like Zhongwen
 *   - `createWorkspaceAuthState()` for encrypted workspace apps where
 *     signed-in means the workspace must be decrypted and usable
 *
 * This module keeps the public DI surface intentionally small:
 *
 * - `authApi` answers "how do auth requests happen in this environment?"
 * - `sessionStore` answers "how is auth state persisted and synchronized?"
 *
 * Workspace auth adds one more dependency: a workspace that can activate and
 * deactivate encryption.
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
 * Persisted session snapshot used by `SessionStore`.
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
 * Minimal persistence boundary for auth state.
 *
 * The auth controller reads and writes complete session snapshots through this
 * interface instead of mutating raw reactive cells directly. Stores may also
 * expose `subscribe()` for cross-context sync such as `chrome.storage`.
 */
export type SessionStore = {
	ready: Promise<void>;
	read: () => SessionSnapshot;
	write: (snapshot: SessionSnapshot) => void | Promise<void>;
	clear: () => void | Promise<void>;
	subscribe?: (
		listener: (snapshot: SessionSnapshot) => void,
	) => (() => void) | undefined;
};

type AuthSession = {
	session: SessionSnapshot;
	encryptionKey?: string | null;
};

type TransportError = Error & {
	status?: number;
};

type BetterAuthClient = ReturnType<typeof createAuthClient>;

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
 * Auth API boundary between the auth controller and Better Auth.
 *
 * The only environment-specific questions this module needs answered are:
 *
 * - how auth requests happen in this environment
 * - how auth state is persisted in this environment
 *
 * `AuthApi` answers the first question. It normalizes Better Auth responses
 * into a stable `SessionSnapshot` plus optional encryption key. The controller
 * owns persistence and phase transitions; the auth API only
 * performs auth I/O.
 */
export type AuthApi = {
	signIn: (credentials: EmailSignInCredentials) => Promise<AuthSession>;
	signUp: (credentials: EmailSignUpCredentials) => Promise<AuthSession>;
	signInWithGoogle: () => Promise<AuthSession>;
	signOut: (input: { token: string | null }) => Promise<void>;
	getSession: (input: { token: string | null }) => Promise<AuthSession | null>;
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

type SessionAuthStateConfig = {
	authApi: AuthApi;
	sessionStore: SessionStore;
};

type WorkspaceAuthStateConfig = SessionAuthStateConfig & {
	workspace: WorkspaceHandle;
	restoreUserKey?: () => Promise<Uint8Array | null>;
};

type InternalLifecycle = {
	beforeCheckSession?: (snapshot: SessionSnapshot) => Promise<void>;
	onAuthenticated?: (session: AuthSession) => Promise<void>;
	onSignedOut?: () => Promise<void>;
	onExternalSignedIn?: (snapshot: SessionSnapshot) => Promise<void>;
};

class AuthFlowInterrupt extends Error {
	kind: 'redirect';

	constructor(kind: 'redirect') {
		super('Redirect started');
		this.kind = kind;
	}
}

// ─── Session stores ─────────────────────────────────────────────────────────

/**
 * LocalStorage-backed session store for web apps.
 *
 * This is the generic replacement for `createLocalStorage()`. It persists the
 * token and cached user in localStorage and exposes them as a `SessionStore`
 * snapshot rather than as raw reactive cells.
 *
 * @example
 * ```typescript
 * const sessionStore = createLocalSessionStore('zhongwen');
 *
 * const authState = createSessionAuthState({
 *   authApi,
 *   sessionStore,
 * });
 * ```
 */
export function createLocalSessionStore(prefix: string): SessionStore {
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
 * Adapter from reactive token/user cells to `SessionStore`.
 *
 * This is primarily for extension code that already uses storage wrappers like
 * `createStorageState()`. The auth layer gets a proper store boundary while the
 * app can keep its existing reactive storage implementation.
 *
 * If the cells expose `watch()`, the returned store forwards those changes
 * through `subscribe()` so the auth controller can react to sign-in/sign-out
 * from other extension contexts.
 */
export function createReactiveSessionStore({
	token,
	user,
	ready,
}: {
	token: ReactiveCell<string | null>;
	user: ReactiveCell<StoredUser | null>;
	ready?: Promise<void>;
}): SessionStore {
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

// ─── Better Auth authApi ───────────────────────────────────────────────────

/**
 * Create the web `AuthApi` for standard browser apps.
 *
 * Google sign-in uses Better Auth's redirect flow. After the redirect starts,
 * the browser navigates away and the page never returns to the original call
 * site; the auth controller treats that as an interrupt rather than a failure.
 */
export function createWebAuthApi({
	baseURL,
}: {
	baseURL: string | (() => string);
}): AuthApi {
	return createAuthApi({
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
 * Create an auth API backed by Better Auth.
 *
 * Most apps should use `createWebAuthApi()`. This lower-level constructor
 * exists for environments like the Chrome extension where Google sign-in
 * must be initiated differently.
 */
export function createAuthApi({
	baseURL,
	signInWithGoogle,
}: {
	baseURL: string | (() => string);
	signInWithGoogle: (client: BetterAuthClient) => Promise<{ user: User }>;
}): AuthApi {
	const resolveBaseURL =
		typeof baseURL === 'function' ? baseURL : () => baseURL;

	function createClient(token: string | null) {
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
			const { client, getIssuedToken } = createClient(null);
			const { data, error } = await client.signIn.email(credentials);
			if (error) throw toTransportError(error);
			return toAuthSession(data, getIssuedToken());
		},

		async signUp(credentials) {
			const { client, getIssuedToken } = createClient(null);
			const { data, error } = await client.signUp.email(credentials);
			if (error) throw toTransportError(error);
			return toAuthSession(data, getIssuedToken());
		},

		async signInWithGoogle() {
			const { client, getIssuedToken } = createClient(null);
			const data = await signInWithGoogle(client);
			return toAuthSession(data, getIssuedToken());
		},

		async signOut({ token }) {
			const { client } = createClient(token);
			const { error } = await client.signOut();
			if (error) throw toTransportError(error);
		},

		async getSession({ token }) {
			const { client, getIssuedToken } = createClient(token);
			const { data, error } = await client.getSession();
			if (error) throw toTransportError(error);
			if (!data) return null;

			const customData = data as typeof data & Partial<CustomSessionFields>;
			return {
				session: {
					user: toStoredUser(customData.user),
					token: getIssuedToken() ?? token,
				},
				encryptionKey: customData.encryptionKey ?? null,
			};
		},
	};
}

function toAuthSession(
	data: { user: User } & Partial<CustomSessionFields>,
	token: string | null | undefined,
): AuthSession {
	return {
		session: {
			user: toStoredUser(data.user),
			token: token ?? null,
		},
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

// ─── Auth state controllers ─────────────────────────────────────────────────

/**
 * Generic auth state for apps that only care about session state.
 *
 * This is the new base controller. It owns the phase machine, auth-aware
 * fetch, session validation policy, and persistence orchestration. It does not
 * know anything about workspaces or encryption.
 *
 * Use this for apps like Zhongwen.
 */
export function createSessionAuthState({
	authApi,
	sessionStore,
}: SessionAuthStateConfig) {
	return createAuthController({ authApi, sessionStore }, {});
}

/**
 * Auth state for encrypted workspace apps.
 *
 * This wraps the generic session controller with the product invariant that a
 * signed-in user must have an active decrypted workspace. `checkSession()`
 * restores a cached user key before the server roundtrip when available, then
 * replaces it with the authoritative server key from `getSession()`.
 */
export function createWorkspaceAuthState({
	authApi,
	sessionStore,
	workspace,
	restoreUserKey,
}: WorkspaceAuthStateConfig) {
	return createAuthController(
		{ authApi, sessionStore },
		{
			async beforeCheckSession(snapshot) {
				if (!snapshot.user || !restoreUserKey) return;
				const cachedKey = await restoreUserKey();
				if (cachedKey) {
					await workspace.activateEncryption(cachedKey);
				}
			},
			async onAuthenticated(session) {
				if (!session.encryptionKey) return;
				await workspace.activateEncryption(
					base64ToBytes(session.encryptionKey),
				);
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
		},
	);
}

function createAuthController(
	{ authApi, sessionStore }: SessionAuthStateConfig,
	lifecycle: InternalLifecycle,
) {
	let pendingAction = $state<'checking' | 'signing-in' | 'signing-out' | null>(
		sessionStore.read().user ? null : 'checking',
	);
	let lastError = $state<string | undefined>(undefined);
	let hasExternalSession = $state(Boolean(sessionStore.read().user));

	function getStatus(): AuthStatus {
		if (pendingAction) return pendingAction;
		return sessionStore.read().user ? 'signed-in' : 'signed-out';
	}

	async function writeAuthenticatedSession(session: AuthSession) {
		await sessionStore.write(session.session);
		await lifecycle.onAuthenticated?.(session);
		lastError = undefined;
	}

	async function clearSession() {
		await sessionStore.clear();
		await lifecycle.onSignedOut?.();
	}

	async function authenticate(
		run: () => Promise<AuthSession>,
		errorPrefix: string,
	) {
		pendingAction = 'signing-in';

		try {
			const session = await run();
			await writeAuthenticatedSession(session);
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

	sessionStore.subscribe?.((snapshot) => {
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
			return sessionStore.read().user;
		},

		get token() {
			return sessionStore.read().token;
		},

		/**
		 * Auth-aware fetch wrapper.
		 *
		 * It always sends `credentials: 'include'` so cookie-backed auth flows
		 * continue to work, and it adds `Authorization: Bearer <token>` when the
		 * current session store has a token.
		 */
		fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const token = sessionStore.read().token;
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
		 * Sign in with email/password.
		 *
		 * On success the session store is updated, `checkSession()` semantics are
		 * preserved, and workspace auth wrappers activate encryption automatically.
		 */
		async signIn(credentials: EmailSignInCredentials) {
			await authenticate(() => authApi.signIn(credentials), 'Sign-in failed');
		},

		/**
		 * Create an account with email/password/name.
		 *
		 * The auth controller treats sign-up as another session-producing auth
		 * action. The same persistence, error, and workspace rules apply.
		 */
		async signUp(credentials: EmailSignUpCredentials) {
			await authenticate(() => authApi.signUp(credentials), 'Sign-up failed');
		},

		/**
		 * Start the Google sign-in flow through the configured auth API.
		 *
		 * Web auth APIs typically redirect the page; extension auth APIs complete
		 * in-place and return a session result.
		 */
		async signInWithGoogle() {
			await authenticate(
				() => authApi.signInWithGoogle(),
				'Google sign-in failed',
			);
		},

		/**
		 * Sign out locally and on the server.
		 *
		 * The local session is always cleared, even if the server sign-out call
		 * fails. Workspace auth wrappers also deactivate encryption here.
		 */
		async signOut() {
			pendingAction = 'signing-out';
			try {
				await authApi.signOut({ token: sessionStore.read().token });
			} catch {}
			await clearSession();
			pendingAction = null;
		},

		/**
		 * Validate the current session against the server.
		 *
		 * The controller deliberately does not require a local bearer token before
		 * making this request. Cookie-backed flows may have a valid server session
		 * even when the local token is missing or stale.
		 *
		 * Unreachable server responses keep cached session state so offline users
		 * are not logged out. Explicit auth rejections clear the store.
		 */
		async checkSession() {
			await sessionStore.ready;
			pendingAction = 'checking';

			const snapshot = sessionStore.read();
			await lifecycle.beforeCheckSession?.(snapshot);

			try {
				const session = await authApi.getSession({
					token: snapshot.token,
				});

				if (!session) {
					await clearSession();
					pendingAction = null;
					return null;
				}

				await writeAuthenticatedSession(session);
				pendingAction = null;
				return session.session.user;
			} catch (cause) {
				const error = toTransportError(cause);
				const isAuthRejection =
					error.status !== undefined && error.status < 500;

				if (isAuthRejection) {
					await clearSession();
					pendingAction = null;
					return null;
				}

				const cachedUser = sessionStore.read().user;
				pendingAction = null;
				return cachedUser;
			}
		},
	};
}
