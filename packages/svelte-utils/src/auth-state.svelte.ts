/**
 * Auth state factory for Epicenter client apps.
 *
 * Owns the phase machine, Better Auth client, session validation, and
 * token refresh. Creates its own persisted storage internally—no adapter
 * layer. Each app passes a `storagePrefix` and workspace callbacks.
 *
 * Actions take explicit parameters—form state lives in the component.
 *
 * @example
 * ```typescript
 * export const authState = createAuthState({
 *   baseURL: 'https://api.epicenter.so',
 *   storagePrefix: 'honeycrisp',
 *   onSignedIn: (key) => { workspace.activateEncryption(key); workspace.sync.reconnect(); },
 *   onSignedOut: () => { workspace.deactivateEncryption(); workspace.sync.reconnect(); },
 * });
 * ```
 */

import { createPersistedState } from './persisted-state.svelte';
import { type } from 'arktype';
import { createAuthClient } from 'better-auth/client';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';

// ─── Types (inlined—only used by this factory) ──────────────────────────────

/** Custom fields from the server's customSession plugin. */
type CustomSessionFields = { encryptionKey: string; keyVersion: number };

const AuthUser = type({
	id: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
});

export type AuthUser = typeof AuthUser.infer;

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

// ─── Token Store ─────────────────────────────────────────────────────────────

/**
 * Raw localStorage get/set for the auth token. No JSON serialization,
 * no Svelte reactivity—the token is infrastructure, never displayed.
 * Used by both the auth factory (read/write) and the sync extension (read).
 */
export type TokenStore = {
	get(): string | undefined;
	set(value: string | undefined): void;
};

/** Create a token store backed by raw localStorage. */
export function createTokenStore(storagePrefix: string): TokenStore {
	const key = `${storagePrefix}:authToken`;
	return {
		get() {
			return localStorage.getItem(key) ?? undefined;
		},
		set(value) {
			if (value === undefined) {
				localStorage.removeItem(key);
			} else {
				localStorage.setItem(key, value);
			}
		},
	};
}

// ─── Config ──────────────────────────────────────────────────────────────────

export type AuthStateConfig = {
	/** Base URL for the Better Auth API (e.g. `https://api.epicenter.so`). */
	baseURL: string;
	/** Prefix for localStorage keys (e.g. `'honeycrisp'` → `'honeycrisp:authUser'`). */
	storagePrefix: string;
	/** Token store for reading/writing the auth token. */
	tokenStore: TokenStore;
	/**
	 * Override for Google sign-in. Web apps leave undefined to use Better Auth's
	 * built-in redirect flow. Chrome extensions pass a function that uses
	 * `chrome.identity.launchWebAuthFlow`.
	 */
	signInWithGoogle?: () => Promise<AuthUser>;
	/** Called after successful sign-in with the encryption key from the session. */
	onSignedIn?: (encryptionKey: string) => Promise<void>;
	/** Called after sign-out. */
	onSignedOut?: () => Promise<void>;
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

export function createAuthState(config: AuthStateConfig) {
	const { baseURL, storagePrefix, tokenStore } = config;

	// User state needs reactivity (displayed in UI) + schema validation
	const userState = createPersistedState({
		key: `${storagePrefix}:authUser`,
		schema: AuthUser.or('undefined'),
		defaultValue: undefined,
	});

	let phase = $state<AuthPhase>({ status: 'checking' });

	const client = createAuthClient({
		baseURL,
		basePath: '/auth',
		fetchOptions: {
			auth: {
				type: 'Bearer',
				token: () => tokenStore.get(),
			},
			onSuccess: ({ response }) => {
				const newToken = response.headers.get('set-auth-token');
				if (newToken) tokenStore.set(newToken);
			},
		},
	});

	// ─── Private Helpers ───

	async function getSession() {
		const { data, error } = await client.getSession();
		const customData = data
			? (data as typeof data & CustomSessionFields)
			: null;
		return { data: customData, error };
	}

	function clearState() {
		tokenStore.set(undefined);
		userState.current = undefined;
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

	/**
	 * Wraps `globalThis.fetch` with auth credentials.
	 *
	 * Mirrors Better Auth's internal `$fetch` behavior: always sends
	 * `credentials: 'include'` (session cookie) and adds the Bearer
	 * token when available. This ensures requests authenticate via
	 * cookie even before the token is stored (e.g. after OAuth redirect).
	 */
	const authFetch: typeof fetch = (input, init) => {
		const headers = new Headers(init?.headers);
		const token = tokenStore.get();
		if (token) headers.set('Authorization', `Bearer ${token}`);
		return fetch(input, { ...init, headers, credentials: 'include' });
	};

	return {
		get status() {
			return phase.status;
		},

		get signInError(): string | undefined {
			return phase.status === 'signed-out' ? phase.error : undefined;
		},

		get user() {
			return userState.current;
		},

		get token() {
			return tokenStore.get();
		},

		fetch: authFetch,

		async signIn(credentials: { email: string; password: string }) {
			phase = { status: 'signing-in' };

			const result = await tryAsync({
				try: async () => {
					const { data, error: authError } =
						await client.signIn.email(credentials);
					if (authError)
						throw new Error(authError.message ?? authError.statusText);
					const user = serializeDates(data.user);
					userState.current = user;
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
					userState.current = user;
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

		async signInWithGoogle() {
			phase = { status: 'signing-in' };

			if (config.signInWithGoogle) {
				const result = await tryAsync({
					try: async () => {
						const user = await config.signInWithGoogle!();
						userState.current = user;
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
			const result = await getSession().catch(() => null);

			// Network failure (fetch threw) — trust cache or sign out
			if (!result) {
				const cached = userState.current;
				phase = cached ? { status: 'signed-in' } : { status: 'signed-out' };
				return Ok(cached ?? null);
			}

			const { data, error: sessionError } = result;

			if (sessionError) {
				const isAuthRejection =
					sessionError.status && sessionError.status < 500;

				if (!isAuthRejection) {
					const cached = userState.current;
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
			userState.current = user;
			if (data.encryptionKey) {
				await config.onSignedIn?.(data.encryptionKey);
			}
			phase = { status: 'signed-in' };
			return Ok(user);
		},
	};
}
