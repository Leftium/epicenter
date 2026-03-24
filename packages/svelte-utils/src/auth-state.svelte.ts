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

// ─── Types (inlined—only used by this factory) ──────────────────────────────

/** Custom fields from the server's customSession plugin. */
type CustomSessionFields = { encryptionKey: string; keyVersion: number };

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
	/** Base URL for the Better Auth API. Static string or reactive getter. */
	baseURL: string | (() => string);
	/** Pluggable storage using the Svelte `.current` reactive value convention. */
	storage: {
		token: { current: string | undefined };
		user: { current: AuthUser | undefined };
	};
	/** Acquire a Google id_token (e.g. via chrome.identity). Factory calls Better Auth. */
	getGoogleIdToken?: () => Promise<{ token: string; nonce: string }>;
	/** Called after successful sign-in with the encryption key from the session. */
	onSignedIn?: (encryptionKey: string) => Promise<void>;
	/** Called after sign-out. */
	onSignedOut?: () => Promise<void>;
	/** Called on external sign-in (e.g. another extension context). */
	onExternalSignIn?: () => Promise<void>;
	/** Resolves when async storage is ready. Omit for sync storage. */
	whenReady?: Promise<void>;
	/** Called at top of checkSession after whenReady, before the server call. */
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

export function createAuthState(config: AuthStateConfig) {
	const { storage } = config;
	const resolveBaseURL =
		typeof config.baseURL === 'function'
			? config.baseURL
			: () => config.baseURL as string;

	let phase = $state<AuthPhase>(
		storage.user.current ? { status: 'signed-in' } : { status: 'checking' },
	);

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

	async function getSession() {
		const { data, error } = await client.getSession();
		const customData = data
			? (data as typeof data & CustomSessionFields)
			: null;
		return { data: customData, error };
	}

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

		handleExternalSignOut() {
			clearState();
			config.onSignedOut?.();
			phase = { status: 'signed-out' };
		},

		handleExternalSignIn() {
			phase = { status: 'signed-in' };
			config.onExternalSignIn?.();
		},
	};
}
