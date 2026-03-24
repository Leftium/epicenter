/**
 * Auth state factory for Epicenter client apps.
 *
 * Owns the phase machine, Better Auth client, session validation, and
 * token refresh. Accepts pluggable storage so both localStorage (web apps)
 * and chrome.storage (extensions) work through the same factory.
 *
 * Actions take explicit parameters—form state lives in the component.
 *
 * @example
 * ```typescript
 * export const authState = createAuthState({
 *   baseURL: 'https://api.epicenter.so',
 *   storage: createLocalStorage('honeycrisp'),
 *   onSignedIn: (key) => { workspace.activateEncryption(key); },
 *   onSignedOut: () => { workspace.deactivateEncryption(); },
 * });
 * ```
 */

import { createPersistedState } from './persisted-state.svelte';
import { type } from 'arktype';
import { createAuthClient } from 'better-auth/client';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Custom fields added to `getSession()` responses by the server's
 * `customSession` plugin. Not present in `signIn`/`signUp` responses—
 * callers must do a separate `getSession()` after login to retrieve
 * the encryption key.
 *
 * Duplicated from `@epicenter/api/src/custom-session-fields` as a plain
 * type so this package has zero server-side imports.
 *
 * @see {@link refreshEncryptionKeyAndNotify} — fetches these after sign-in
 */
type CustomSessionFields = { encryptionKey: string; keyVersion: number };

/**
 * Runtime schema and TypeScript type for the cached auth user.
 *
 * Exported as both a value (arktype validator used by storage adapters)
 * and a type (inferred from the schema). Storage adapters like
 * `createLocalStorage` and `createStorageState` use the runtime schema
 * for validation; the rest of the codebase uses the type.
 */
export const AuthUser = type({
	id: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
});

export type AuthUser = typeof AuthUser.infer;

/**
 * Discriminated union for the auth state machine.
 *
 * ```
 * checking ──► signed-in ──► signing-out ──► signed-out
 *    │                                           │
 *    └──────► signed-out ──► signing-in ─────────┘
 *                                │
 *                                └──► signed-in
 * ```
 *
 * - `checking` — initial state while `whenReady` / `checkSession` resolve
 * - `signing-in` — credentials submitted, waiting for server response
 * - `signing-out` — sign-out in progress (encryption deactivation + server call)
 * - `signed-in` — active session with cached user
 * - `signed-out` — no session; optional `error` from the last failed sign-in
 */
export type AuthPhase =
	| { status: 'checking' }
	| { status: 'signing-in' }
	| { status: 'signing-out' }
	| { status: 'signed-in' }
	| { status: 'signed-out'; error?: string };

const AuthError = defineErrors({
	SignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Sign-in failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignUpFailed: ({ cause }: { cause: unknown }) => ({
		message: `Sign-up failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	GoogleSignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Google sign-in failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

// ─── Config ──────────────────────────────────────────────────────────────────

export type AuthStateConfig = {
	/**
	 * Base URL for the Better Auth API (e.g. `https://api.epicenter.so`).
	 * Pass a getter function for reactive URLs that change at runtime—
	 * the Better Auth client re-creates via `$derived` when the value changes.
	 */
	baseURL: string | (() => string);

	/**
	 * Pluggable storage for the auth token and cached user, following the
	 * Svelte `.current` reactive value convention (same as `$state`, `MediaQuery`,
	 * `createPersistedState`, `createStorageState`).
	 *
	 * Web apps: use `createLocalStorage('prefix')`.
	 * Extensions: pass `createStorageState` instances directly.
	 *
	 * @see {@link createLocalStorage} — convenience helper for localStorage
	 */
	storage: {
		token: { current: string | undefined };
		user: { current: AuthUser | undefined };
	};

	/**
	 * Platform-specific Google id_token acquisition. The factory handles the
	 * Better Auth `client.signIn.social()` call, token capture via `onSuccess`,
	 * and user serialization—the consumer only provides the raw credentials.
	 *
	 * Omit for web apps (factory uses Better Auth's redirect flow instead).
	 *
	 * @returns Google id_token and nonce for Better Auth's `signIn.social({ idToken })` call
	 */
	getGoogleIdToken?: () => Promise<{ token: string; nonce: string }>;

	/**
	 * Called after successful sign-in/session validation with the encryption
	 * key from the server's `customSession` plugin. The key is a base64-encoded
	 * HKDF-derived per-user key—consumers typically call
	 * `workspace.activateEncryption(base64ToBytes(key))`.
	 *
	 * Fires on: `signIn`, `signUp`, `signInWithGoogle`, `checkSession` (when valid).
	 */
	onSignedIn?: (encryptionKey: string) => Promise<void>;

	/** Called on sign-out (explicit or server-rejected session). */
	onSignedOut?: () => Promise<void>;

	/**
	 * Called when another context signs in (e.g. extension popup signs in,
	 * sidebar detects it via `chrome.storage` watcher). Unlike `onSignedIn`,
	 * there's no encryption key from the server—the consumer typically
	 * restores from a local key cache instead.
	 */
	onExternalSignIn?: () => Promise<void>;

	/**
	 * Promise that resolves when async storage has loaded its initial values.
	 * `checkSession` awaits this before reading `storage.token.current` so it
	 * doesn't see a stale fallback.
	 *
	 * Omit for synchronous storage (localStorage reads on construction).
	 */
	whenReady?: Promise<void>;

	/**
	 * Called at the start of `checkSession`, after `whenReady` resolves but
	 * before the server roundtrip. Used by the tab manager to restore
	 * encryption from a local key cache for instant startup—the cached key
	 * is later superseded by the server's authoritative key.
	 */
	onCheckSessionStart?: () => Promise<void>;
};

/**
 * Create a localStorage-backed storage object for use with `createAuthState`.
 *
 * Web apps use this helper. Extensions pass their own storage objects
 * (e.g. `createStorageState` from `@wxt-dev/storage`).
 */
export function createLocalStorage(prefix: string): AuthStateConfig['storage'] {
	const tokenKey = `${prefix}:authToken`;
	const userState = createPersistedState({
		key: `${prefix}:authUser`,
		schema: AuthUser,
	});
	return {
		token: {
			get current() {
				return localStorage.getItem(tokenKey) ?? undefined;
			},
			set current(v: string | undefined) {
				v === undefined
					? localStorage.removeItem(tokenKey)
					: localStorage.setItem(tokenKey, v);
			},
		},
		user: userState,
	};
}

function serializeDates<T extends Record<string, unknown>>(obj: T) {
	return Object.fromEntries(
		Object.entries(obj).map(([key, value]) => [
			key,
			value instanceof Date ? value.toISOString() : value,
		]),
	) as { [K in keyof T]: T[K] extends Date ? string : T[K] };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an auth state singleton for an Epicenter app.
 *
 * Manages the full auth lifecycle: phase machine, Better Auth client,
 * session validation with offline tolerance, token refresh (via the
 * server's `bearer()` plugin `set-auth-token` header), and encryption
 * lifecycle callbacks.
 *
 * The returned object is a Svelte 5 reactive singleton—`status`, `user`,
 * `token`, and `signInError` are reactive getters backed by `$state`.
 *
 * @param config - App-specific configuration (storage, callbacks, base URL)
 * @returns Reactive auth state with `signIn`, `signUp`, `signInWithGoogle`,
 *          `signOut`, `checkSession`, and external sign-in/out handlers
 *
 * @example Web app (honeycrisp)
 * ```typescript
 * export const authState = createAuthState({
 *   baseURL: APP_URLS.API,
 *   storage: createLocalStorage('honeycrisp'),
 *   onSignedIn: (key) => workspace.activateEncryption(base64ToBytes(key)),
 *   onSignedOut: () => workspace.deactivateEncryption(),
 * });
 * ```
 *
 * @example Chrome extension (tab-manager)
 * ```typescript
 * export const authState = createAuthState({
 *   baseURL: () => remoteServerUrl.current,
 *   storage: { token: authToken, user: authUser },
 *   whenReady: Promise.all([authToken.whenReady, authUser.whenReady]),
 *   getGoogleIdToken: () => chromeIdentityFlow(),
 *   onSignedIn: (key) => workspace.activateEncryption(base64ToBytes(key)),
 *   onSignedOut: () => workspace.deactivateEncryption(),
 * });
 * ```
 */
export function createAuthState(config: AuthStateConfig) {
	const { storage } = config;
	const resolveBaseURL =
		typeof config.baseURL === 'function'
			? config.baseURL
			: () => config.baseURL as string;

	let phase = $state<AuthPhase>(
		storage.user.current ? { status: 'signed-in' } : { status: 'checking' },
	);

	/**
	 * Better Auth client, re-created via `$derived` when `baseURL` changes.
	 *
	 * Injects `Authorization: Bearer <token>` on every request via
	 * `fetchOptions.auth`. Captures rotated tokens from the server's
	 * `bearer()` plugin via the `set-auth-token` response header in
	 * `onSuccess`—this is Better Auth's built-in token refresh mechanism.
	 */
	const client = $derived(
		createAuthClient({
			baseURL: resolveBaseURL(),
			basePath: '/auth',
			fetchOptions: {
				auth: {
					type: 'Bearer',
					token: () => storage.token.current,
				},
				onSuccess: ({ response }) => {
					const newToken = response.headers.get('set-auth-token');
					if (newToken) storage.token.current = newToken;
				},
			},
		}),
	);

	// ─── Private Helpers ───

	/**
	 * Typed wrapper around `client.getSession()` that includes custom session
	 * fields (`encryptionKey`, `keyVersion`).
	 *
	 * Better Auth's client doesn't know about `customSession` fields without
	 * the `customSessionClient<typeof auth>()` plugin—which would pull in
	 * all server-side dependencies. This wrapper centralizes the single type
	 * assertion so callers get typed access without the import cost.
	 *
	 * @internal
	 */
	async function getSession() {
		const { data, error } = await client.getSession();
		const customData = data
			? (data as typeof data & CustomSessionFields)
			: null;
		return { data: customData, error };
	}

	/** @internal */
	function clearState() {
		storage.token.current = undefined;
		storage.user.current = undefined;
	}

	/**
	 * Fetch the session to get the encryption key, then notify the app.
	 * signIn/signUp responses don't include customSession fields—only
	 * getSession() returns them.
	 */
	async function refreshEncryptionKeyAndNotify() {
		const result = await getSession().catch(() => null);
		if (result?.data?.encryptionKey) {
			await config.onSignedIn?.(result.data.encryptionKey);
		}
	}

	// ─── Public API ───

	return {
		get status() {
			return phase.status;
		},

		get signInError(): string | undefined {
			return phase.status === 'signed-out' ? phase.error : undefined;
		},

		get user() {
			return storage.user.current;
		},

		get token() {
			return storage.token.current;
		},

		/**
		 * Auth-aware fetch that injects `Authorization: Bearer <token>`.
		 * Used by libraries that accept a custom `fetch` (e.g. `@tanstack/ai-client`).
		 */
		fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			const token = storage.token.current;
			if (token) headers.set('Authorization', `Bearer ${token}`);
			return fetch(input, { ...init, headers, credentials: 'include' });
		}) as typeof fetch,

		/** Sign in with email/password. Returns `Ok(AuthUser)` or `Err(SignInFailed)`. */
		async signIn(credentials: { email: string; password: string }) {
			phase = { status: 'signing-in' };

			const result = await tryAsync({
				try: async () => {
					const { data, error: authError } =
						await client.signIn.email(credentials);
					if (authError)
						throw new Error(authError.message ?? authError.statusText);
					const user = serializeDates(data.user);
					storage.user.current = user;
					return user;
				},
				catch: (cause) => AuthError.SignInFailed({ cause }),
			});

			if (result.error) {
				phase = { status: 'signed-out', error: result.error.message };
			} else {
				phase = { status: 'signed-in' };
				await refreshEncryptionKeyAndNotify();
			}

			return result;
		},

		/** Create account with email/password/name. Returns `Ok(AuthUser)` or `Err(SignUpFailed)`. */
		async signUp(credentials: {
			email: string;
			password: string;
			name: string;
		}) {
			phase = { status: 'signing-in' };

			const result = await tryAsync({
				try: async () => {
					const { data, error: authError } =
						await client.signUp.email(credentials);
					if (authError)
						throw new Error(authError.message ?? authError.statusText);
					const user = serializeDates(data.user);
					storage.user.current = user;
					return user;
				},
				catch: (cause) => AuthError.SignUpFailed({ cause }),
			});

			if (result.error) {
				phase = { status: 'signed-out', error: result.error.message };
			} else {
				phase = { status: 'signed-in' };
				await refreshEncryptionKeyAndNotify();
			}

			return result;
		},

		/**
		 * Sign in with Google. Two paths:
		 *
		 * 1. **Extension** (`getGoogleIdToken` provided): calls the config function
		 *    to get a Google `id_token` via `chrome.identity`, then exchanges it
		 *    through `client.signIn.social({ idToken })`. Token capture and user
		 *    serialization happen inside the factory.
		 *
		 * 2. **Web app** (no override): calls `client.signIn.social({ provider: 'google' })`
		 *    which triggers a full-page redirect to Google. The method never resolves
		 *    normally—Better Auth handles the redirect callback.
		 */
		async signInWithGoogle() {
			phase = { status: 'signing-in' };

			if (config.getGoogleIdToken) {
				const result = await tryAsync({
					try: async () => {
						const idToken = await config.getGoogleIdToken!();
						const { data, error: authError } =
							await client.signIn.social({
								provider: 'google',
								idToken,
							});
						if (authError)
							throw new Error(authError.message ?? authError.statusText);
						if (!data || !('user' in data))
							throw new Error('Unexpected response from server');
						const user = serializeDates(data.user);
						storage.user.current = user;
						return user;
					},
					catch: (cause) => {
						const message = cause instanceof Error ? cause.message : '';
						if (message.includes('canceled') || message.includes('cancelled')) {
							return AuthError.GoogleSignInFailed({
								cause: new Error('Cancelled'),
							});
						}
						return AuthError.GoogleSignInFailed({ cause });
					},
				});

				if (result.error) {
					const isCancelled = result.error.message.includes('Cancelled');
					phase = {
						status: 'signed-out',
						error: isCancelled ? undefined : result.error.message,
					};
				} else {
					phase = { status: 'signed-in' };
					await refreshEncryptionKeyAndNotify();
				}

				return result;
			}

			// Default: Better Auth redirect flow for web apps
			const result = await tryAsync({
				try: async () => {
					await client.signIn.social({
						provider: 'google',
						callbackURL: window.location.origin,
					});
					throw new Error('Expected redirect');
				},
				catch: (cause) => AuthError.GoogleSignInFailed({ cause }),
			});

			if (result.error) {
				phase = { status: 'signed-out', error: result.error.message };
			}

			return result;
		},

		/** Sign out—deactivates encryption, invalidates server session, clears local state. */
		async signOut() {
			phase = { status: 'signing-out' };
			await config.onSignedOut?.();
			await client.signOut().catch(() => {});
			clearState();
			phase = { status: 'signed-out' };
			return Ok(undefined);
		},

		/**
		 * Validate the stored session against the server.
		 *
		 * Call on app mount and on visibility change. Unreachable server
		 * (network error / 5xx) trusts the cached user so offline users
		 * aren't logged out. Only an explicit auth rejection (4xx) clears state.
		 */
		async checkSession() {
			if (config.whenReady) await config.whenReady;
			if (config.onCheckSessionStart) await config.onCheckSessionStart();

			const token = storage.token.current;
			if (!token) {
				phase = { status: 'signed-out' };
				return Ok(null);
			}

			const { data, error: sessionError } = await getSession();

			if (sessionError) {
				const isAuthRejection =
					sessionError.status && sessionError.status < 500;

				if (!isAuthRejection) {
					const cached = storage.user.current;
					phase = cached ? { status: 'signed-in' } : { status: 'signed-out' };
					return Ok(cached ?? null);
				}

				clearState();
				await config.onSignedOut?.();
				phase = { status: 'signed-out' };
				return Ok(null);
			}

			if (!data) {
				clearState();
				await config.onSignedOut?.();
				phase = { status: 'signed-out' };
				return Ok(null);
			}

			const user = serializeDates(data.user);
			storage.user.current = user;
			if (data.encryptionKey) {
				await config.onSignedIn?.(data.encryptionKey);
			}
			phase = { status: 'signed-in' };
			return Ok(user);
		},

		/**
		 * Transition to signed-out due to an external storage change (e.g.
		 * another extension context cleared the auth token). Clears local
		 * state and fires `onSignedOut`.
		 *
		 * Consumers wire this to storage watchers outside the factory:
		 * ```typescript
		 * authToken.watch((token) => {
		 *   if (!token && authState.status === 'signed-in') authState.handleExternalSignOut();
		 * });
		 * ```
		 */
		handleExternalSignOut() {
			clearState();
			config.onSignedOut?.();
			phase = { status: 'signed-out' };
		},

		/**
		 * Transition to signed-in due to an external storage change (e.g.
		 * another extension context signed in and wrote the user to chrome.storage).
		 * Fires `onExternalSignIn` so the consumer can restore encryption
		 * from a local key cache (no server key available on this path).
		 */
		handleExternalSignIn() {
			phase = { status: 'signed-in' };
			config.onExternalSignIn?.();
		},
	};
}
