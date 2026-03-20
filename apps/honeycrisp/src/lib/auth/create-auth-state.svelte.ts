/**
 * Auth state factory—shared logic for all Epicenter client apps.
 *
 * Owns the phase machine, Better Auth client, session validation, and
 * token refresh. Platform-specific behavior (storage, OAuth flow, workspace
 * integration) is injected via {@link AuthStateConfig}.
 *
 * Actions take explicit parameters—form state lives in the component,
 * not in the auth singleton.
 *
 * @example
 * ```typescript
 * const authState = createAuthState({
 *   baseURL: 'https://api.epicenter.so',
 *   tokenStorage: localStorageAdapter({ key: 'authToken', ... }),
 *   userStorage: localStorageAdapter({ key: 'authUser', ... }),
 *   onSignedIn: (key) => workspace.activateEncryption(key),
 *   onSignedOut: () => workspace.deactivateEncryption(),
 * });
 * ```
 */

/** Custom fields from the server's customSession plugin. */
type CustomSessionFields = { encryptionKey: string; keyVersion: number };
import { createAuthClient } from 'better-auth/client';
import { Ok, tryAsync } from 'wellcrafted/result';
import { AuthError, type AuthPhase, type AuthStateConfig } from './types';

/** Convert all `Date` properties in an object to ISO strings. */
function serializeDates<T extends Record<string, unknown>>(obj: T) {
	return Object.fromEntries(
		Object.entries(obj).map(([key, value]) => [
			key,
			value instanceof Date ? value.toISOString() : value,
		]),
	) as { [K in keyof T]: T[K] extends Date ? string : T[K] };
}

/**
 * Create an auth state instance with injected platform adapters.
 *
 * The returned object is a Svelte 5 reactive singleton—`status`, `user`,
 * and `token` are live `$derived`-compatible getters. Actions (`signIn`,
 * `signUp`, `signInWithGoogle`, `signOut`, `checkSession`) are async
 * methods that return `Result` types and never throw.
 */
export function createAuthState(config: AuthStateConfig) {
	const { baseURL, tokenStorage, userStorage } = config;

	// ─── Reactive State ───

	let phase = $state<AuthPhase>({ status: 'checking' });

	const client = createAuthClient({
		baseURL,
		basePath: '/auth',
		fetchOptions: {
			auth: {
				type: 'Bearer',
				token: () => tokenStorage.get(),
			},
			onSuccess: ({ response }) => {
				const newToken = response.headers.get('set-auth-token');
				if (newToken) void tokenStorage.set(newToken);
			},
		},
	});

	// ─── Private Helpers ───

	/**
	 * Typed wrapper around `client.getSession()` that includes custom
	 * session fields (encryptionKey, keyVersion).
	 */
	async function getSession() {
		const { data, error } = await client.getSession();
		const customData = data
			? (data as typeof data & CustomSessionFields)
			: null;
		return { data: customData, error };
	}

	async function clearState() {
		await Promise.all([
			tokenStorage.set(undefined),
			userStorage.set(undefined),
		]);
	}

	/**
	 * Fetch the session to extract the encryption key, then notify the
	 * app via `onSignedIn`. Better Auth's signIn/signUp responses don't
	 * include customSession fields—only getSession() returns them.
	 */
	async function refreshEncryptionKeyAndNotify() {
		const result = await getSession().catch(() => null);
		await config.onSignedIn?.(result?.data?.encryptionKey);
	}

	// ─── Public API ───

	return {
		/** Current auth phase status. */
		get status() {
			return phase.status;
		},

		/** Error message from the last failed sign-in attempt, if any. */
		get signInError(): string | undefined {
			return phase.status === 'signed-out' ? phase.error : undefined;
		},

		/** The cached authenticated user, or undefined if signed out. */
		get user() {
			return userStorage.get();
		},

		/** The current auth token, or undefined if signed out. */
		get token() {
			return tokenStorage.get();
		},

		/**
		 * Sign in with email and password.
		 *
		 * Takes explicit credentials—form state lives in the component.
		 */
		async signIn(credentials: { email: string; password: string }) {
			phase = { status: 'signing-in' };

			const result = await tryAsync({
				try: async () => {
					const { data, error: authError } =
						await client.signIn.email(credentials);
					if (authError)
						throw new Error(authError.message ?? authError.statusText);
					const user = serializeDates(data.user);
					await userStorage.set(user);
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

		/**
		 * Sign up with email, password, and name.
		 *
		 * Takes explicit credentials—form state lives in the component.
		 */
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
					await userStorage.set(user);
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
		 * Sign in with Google.
		 *
		 * Web apps use Better Auth's built-in redirect flow. Chrome extensions
		 * can override this via `config.signInWithGoogle` to use
		 * `chrome.identity.launchWebAuthFlow`.
		 */
		async signInWithGoogle() {
			phase = { status: 'signing-in' };

			if (config.signInWithGoogle) {
				// Platform override (e.g. chrome.identity)
				const result = await tryAsync({
					try: async () => {
						const user = await config.signInWithGoogle!();
						await userStorage.set(user);
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
					await client.signIn.social({ provider: 'google' });
					// Redirect-based—the page will navigate away.
					// If we reach here, something went wrong.
					throw new Error('Expected redirect');
				},
				catch: (cause) => AuthError.GoogleSignInFailed({ cause }),
			});

			if (result.error) {
				phase = { status: 'signed-out', error: result.error.message };
			}

			return result;
		},

		/** Sign out—server-side invalidation + clear local state. */
		async signOut() {
			phase = { status: 'signing-out' };
			await config.onSignedOut?.();
			await client.signOut().catch(() => {});
			await clearState().catch(() => {});
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
			await Promise.all([tokenStorage.whenReady, userStorage.whenReady]);

			const token = tokenStorage.get();
			if (!token) {
				phase = { status: 'signed-out' };
				return Ok(null);
			}

			const { data, error: sessionError } = await getSession();

			if (sessionError) {
				const isAuthRejection =
					sessionError.status && sessionError.status < 500;

				if (!isAuthRejection) {
					// Network error or 5xx—trust cached user
					const cached = userStorage.get();
					phase = cached ? { status: 'signed-in' } : { status: 'signed-out' };
					return Ok(cached ?? null);
				}

				// 4xx—server explicitly rejected the token
				await clearState();
				await config.onSignedOut?.();
				phase = { status: 'signed-out' };
				return Ok(null);
			}

			if (!data) {
				await clearState();
				await config.onSignedOut?.();
				phase = { status: 'signed-out' };
				return Ok(null);
			}

			const user = serializeDates(data.user);
			await userStorage.set(user);
			if (data.encryptionKey) {
				await config.onSignedIn?.(data.encryptionKey);
			}
			phase = { status: 'signed-in' };
			return Ok(user);
		},
	};
}
