/**
 * Auth state factory for Epicenter client apps.
 *
 * Owns the phase machine, Better Auth client, session validation, and
 * token refresh. Accepts pluggable storage and custom sign-in strategies.
 *
 * Built-in methods: `signIn` (email/password), `signUp`, `signOut`, `checkSession`.
 * Custom strategies (e.g. Google OAuth) are passed via `strategies` config—
 * the factory wraps each one with the phase machine, error handling, user
 * serialization, and encryption key refresh.
 *
 * @example Web app
 * ```typescript
 * export const authState = createAuthState({
 *   baseURL: APP_URLS.API,
 *   storage: createLocalStorage('honeycrisp'),
 *   strategies: { signInWithGoogle: googleRedirect },
 *   onSignedIn: (key) => workspace.activateEncryption(base64ToBytes(key)),
 *   onSignedOut: () => workspace.deactivateEncryption(),
 * });
 * ```
 *
 * @example Chrome extension
 * ```typescript
 * export const authState = createAuthState({
 *   baseURL: () => remoteServerUrl.current,
 *   storage: { token: authToken, user: authUser },
 *   strategies: { signInWithGoogle: chromeGoogleStrategy },
 *   whenReady: Promise.all([authToken.whenReady, authUser.whenReady]),
 *   onSignedIn: (key) => workspace.activateEncryption(base64ToBytes(key)),
 *   onSignedOut: () => workspace.deactivateEncryption(),
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

/**
 * A custom sign-in strategy. Receives the Better Auth client (for token
 * handling via `onSuccess`) and returns the raw response containing a `user`.
 * The factory handles: phase transitions, `serializeDates`, storage writes,
 * encryption key refresh, cancelled-popup detection, and error wrapping.
 *
 * Throw on failure—the factory catches and wraps with `AuthError.StrategyFailed`.
 * Errors containing 'canceled'/'cancelled' are treated as silent (no UI error).
 *
 * @example Google OAuth via chrome.identity
 * ```typescript
 * const chromeGoogle: Strategy = async (client) => {
 *   const { token, nonce } = await chromeIdentityFlow();
 *   const { data, error } = await client.signIn.social({
 *     provider: 'google',
 *     idToken: { token, nonce },
 *   });
 *   if (error) throw new Error(error.message ?? error.statusText);
 *   if (!data || !('user' in data)) throw new Error('Unexpected response');
 *   return data;
 * };
 * ```
 */
export type Strategy = (
	client: ReturnType<typeof createAuthClient>,
) => Promise<{ user: Record<string, unknown> }>;

const AuthError = defineErrors({
	SignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Sign-in failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignUpFailed: ({ cause }: { cause: unknown }) => ({
		message: `Sign-up failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StrategyFailed: ({ cause }: { cause: unknown }) => ({
		message: `Sign-in failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

// ─── Config ──────────────────────────────────────────────────────────────────

export type AuthStateConfig<
	TStrategies extends Record<string, Strategy> = {},
> = {
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
		token: { current: string | null };
		user: { current: AuthUser | null };
	};

	/**
	 * Custom sign-in strategies. Each entry becomes a zero-arg method on
	 * the returned auth state, wrapped with the phase machine, error handling,
	 * user serialization, and encryption key refresh.
	 *
	 * @example
	 * ```typescript
	 * strategies: {
	 *   signInWithGoogle: googleRedirect,
	 *   signInWithApple: appleStrategy,
	 * }
	 * // → authState.signInWithGoogle(), authState.signInWithApple()
	 * ```
	 */
	strategies?: TStrategies;

	/**
	 * Called after successful sign-in/session validation with the encryption
	 * key from the server's `customSession` plugin. The key is a base64-encoded
	 * HKDF-derived per-user key—consumers typically call
	 * `workspace.activateEncryption(base64ToBytes(key))`.
	 *
	 * Fires on: `signIn`, `signUp`, custom strategies, `checkSession` (when valid).
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a localStorage-backed storage object for use with `createAuthState`.
 *
 * Web apps use this helper. Extensions pass their own storage objects
 * (e.g. `createStorageState` from `@wxt-dev/storage`).
 */
export function createLocalStorage(
	prefix: string,
): AuthStateConfig['storage'] {
	return {
		token: createPersistedState({
			key: `${prefix}:authToken`,
			schema: type('string').or('null'),
			defaultValue: null,
		}),
		user: createPersistedState({
			key: `${prefix}:authUser`,
			schema: AuthUser.or('null'),
			defaultValue: null,
		}),
	};
}

/**
 * Google sign-in strategy for web apps using Better Auth's redirect flow.
 * Navigates to Google's consent screen—the page never returns from this call.
 * After the user consents, Google redirects back and Better Auth handles
 * the callback automatically.
 */
export const googleRedirect: Strategy = async (client) => {
	await client.signIn.social({
		provider: 'google',
		callbackURL: window.location.origin,
	});
	throw new Error('Expected redirect');
};

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
 * @param config - App-specific configuration (storage, callbacks, strategies)
 * @returns Reactive auth state with built-in methods plus one method per strategy
 */
export function createAuthState<
	TStrategies extends Record<string, Strategy> = {},
>(config: AuthStateConfig<TStrategies>) {
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
					token: () => storage.token.current ?? undefined,
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
		storage.token.current = null;
		storage.user.current = null;
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

	/**
	 * Execute a sign-in strategy with the full phase machine lifecycle.
	 *
	 * Handles: phase transitions, `tryAsync` error wrapping, date serialization,
	 * user storage writes, encryption key refresh, and cancelled-popup detection
	 * (errors containing 'canceled'/'cancelled' produce no UI error).
	 *
	 * @internal
	 */
	async function executeStrategy(fn: Strategy) {
		phase = { status: 'signing-in' };

		const result = await tryAsync({
			try: async () => {
				const data = await fn(client);
				const user = serializeDates(data.user);
				storage.user.current = user;
				return user;
			},
			catch: (cause) => {
				const message = cause instanceof Error ? cause.message : '';
				if (
					message.includes('canceled') ||
					message.includes('cancelled')
				) {
					return AuthError.StrategyFailed({
						cause: new Error('Cancelled'),
					});
				}
				return AuthError.StrategyFailed({ cause });
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

	// ─── Public API ───

	const base = {
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
					phase = cached
						? { status: 'signed-in' }
						: { status: 'signed-out' };
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

	const strategyMethods = Object.fromEntries(
		Object.entries(config.strategies ?? {}).map(([name, fn]) => [
			name,
			() => executeStrategy(fn),
		]),
	);

	return Object.assign(base, strategyMethods) as typeof base & {
		[K in keyof TStrategies]: () => ReturnType<typeof executeStrategy>;
	};
}
