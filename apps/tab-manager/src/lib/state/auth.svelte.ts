/**
 * Auth state singleton for the tab manager extension.
 *
 * Co-locates all auth-related reactive state (session, form fields, loading)
 * and actions (signIn, signUp, signInWithGoogle, signOut, checkSession) in a single module.
 *
 * All actions return Result types — they never throw.
 */

import type { CustomSessionFields } from '@epicenter/api/src/custom-session-fields';
import { createKeyManager, type KeyManager } from '@epicenter/workspace/shared/crypto';
import { type } from 'arktype';
import { createAuthClient } from 'better-auth/client';
import { untrack } from 'svelte';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';
import { keyCache } from './key-cache';
import { remoteServerUrl } from './settings.svelte';
import { createStorageState } from './storage-state.svelte';
import { workspaceClient } from '$lib/workspace';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Public Google OAuth client ID (not a secret). */
const GOOGLE_CLIENT_ID =
	'702083743841-820rm0nhf9kslmvqcikecgkmku5agbbi.apps.googleusercontent.com';

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const AuthUser = type({
	id: 'string',
	createdAt: 'string.date.iso',
	updatedAt: 'string.date.iso',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
});

type AuthUser = typeof AuthUser.infer;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export const AuthError = defineErrors({
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
export type AuthError = InferErrors<typeof AuthError>;

// ─────────────────────────────────────────────────────────────────────────────
// Persisted State (cross-context via chrome.storage)
// ─────────────────────────────────────────────────────────────────────────────

/** Reactive auth token. Read via `authToken.current`. */
const authToken = createStorageState('local:authToken', {
	fallback: undefined,
	schema: type('string').or('undefined'),
});

/** Reactive auth user. Read via `authUser.current`. */
const authUser = createStorageState('local:authUser', {
	fallback: undefined,
	schema: AuthUser.or('undefined'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

type AuthMode = 'sign-in' | 'sign-up';

type AuthPhase =
	| { status: 'checking' }
	| { status: 'signing-in' }
	| { status: 'signing-out' }
	| { status: 'signed-in' }
	| { status: 'signed-out'; error?: string };

function createAuthState(encryption: KeyManager) {
	// ─── State ───

	let phase = $state<AuthPhase>({ status: 'checking' });
	let email = $state('');
	let password = $state('');
	let name = $state('');
	let mode = $state<AuthMode>('sign-in');

	const client = $derived(
		createAuthClient({
			baseURL: remoteServerUrl.current,
			basePath: '/auth',
			fetchOptions: {
				auth: {
					type: 'Bearer',
					token: () => authToken.current,
				},
				onSuccess: ({ response }) => {
					const newToken = response.headers.get('set-auth-token');
					if (newToken) void authToken.set(newToken);
				},
			},
		}),
	);

	const externalSignInListeners = new Set<() => void>();

	// ─── Effects ───

	$effect.root(() => {
		// Token cleared externally (e.g. sign-out in another extension context).
		$effect(() => {
			if (!authToken.current && phase.status === 'signed-in') {
				void authUser.set(undefined);
				phase = { status: 'signed-out' };
			}
		});

		// Token + user set externally (e.g. sign-in in another extension context).
		$effect(() => {
			if (
				authToken.current &&
				authUser.current &&
				phase.status === 'signed-out'
			) {
				phase = { status: 'signed-in' };
				untrack(() => {
					for (const fn of externalSignInListeners) fn();
				});
			}
		});
	});

	// ─── Helpers (private) ───

	/**
	 * Typed wrapper around `client.getSession()` that includes custom session fields.
	 *
	 * Better Auth's client doesn't know about customSession fields without
	 * `customSessionClient<typeof auth>()` (which requires the server type).
	 * This wrapper centralizes the single type assertion so callers get
	 * typed access to `encryptionKey` and `keyVersion` without casting.
	 */
	async function getSession() {
		const { data, error } = await client.getSession();
		const customData = data
			? (data as typeof data & CustomSessionFields)
			: null;
		return { data: customData, error };
	}

	async function clearState() {
		await Promise.all([authToken.set(undefined), authUser.set(undefined)]);
	}

	/**
	 * Fetch the session to extract the encryption key.
	 *
	 * Better Auth's signIn/signUp responses don't include customSession
	 * fields—only getSession() returns them. Awaited after successful
	 * sign-in so the encryption wiring unlocks before the caller's
	 * post-sign-in code runs. No timing gap.
	 *
	 * Network errors are swallowed via `.catch()` because getSession()
	 * can throw on DNS/connectivity failures (better-fetch doesn't wrap
	 * the raw `fetch()` call). Non-fatal—workspace stays in `'none'`
	 * mode until the next checkSession() on visibility change.
	 */
	async function refreshEncryptionKey() {
		// .catch(→ null) swallows network errors; { data: null } covers HTTP errors
		const result = await getSession().catch(() => null);
		if (result?.data?.encryptionKey) {
			await encryption.unlock(result.data.encryptionKey, result.data.user.id);
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
		get email() {
			return email;
		},
		set email(value: string) {
			email = value;
		},
		get password() {
			return password;
		},
		set password(value: string) {
			password = value;
		},
		get name() {
			return name;
		},
		set name(value: string) {
			name = value;
		},
		get mode() {
			return mode;
		},
		set mode(value: AuthMode) {
			mode = value;
		},
		get user() {
			return authUser.current;
		},
		get token() {
			return authToken.current;
		},

		/**
		 * Sign in with the current email and password form state.
		 */
		async signIn() {
			phase = { status: 'signing-in' };

			const result = await tryAsync({
				try: async () => {
					const { data, error: authError } = await client.signIn.email({
						email,
						password,
					});
					if (authError)
						throw new Error(authError.message ?? authError.statusText);
					const user = serializeDates(data.user);
					await authUser.set(user);
					return user;
				},
				catch: (cause) => AuthError.SignInFailed({ cause }),
			});

			if (result.error) {
				phase = { status: 'signed-out', error: result.error.message };
			} else {
				phase = { status: 'signed-in' };
				password = '';
				await refreshEncryptionKey();
			}

			return result;
		},

		/**
		 * Sign up with email, password, and name.
		 */
		async signUp() {
			phase = { status: 'signing-in' };

			const result = await tryAsync({
				try: async () => {
					const { data, error: authError } = await client.signUp.email({
						email,
						password,
						name,
					});
					if (authError)
						throw new Error(authError.message ?? authError.statusText);
					const user = serializeDates(data.user);
					await authUser.set(user);
					return user;
				},
				catch: (cause) => AuthError.SignUpFailed({ cause }),
			});

			if (result.error) {
				phase = { status: 'signed-out', error: result.error.message };
			} else {
				phase = { status: 'signed-in' };
				password = '';
				await refreshEncryptionKey();
			}

			return result;
		},

		/**
		 * Sign in with Google via chrome.identity.launchWebAuthFlow.
		 *
		 * Opens Google OAuth consent popup, extracts the id_token from the
		 * redirect URL fragment, and sends it to Better Auth.
		 */
		async signInWithGoogle() {
			phase = { status: 'signing-in' };

			const result = await tryAsync({
				try: async () => {
					const redirectUri = browser.identity.getRedirectURL();
					const nonce = crypto.randomUUID();
					const authUrl = new URL(
						'https://accounts.google.com/o/oauth2/v2/auth',
					);
					authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
					authUrl.searchParams.set('redirect_uri', redirectUri);
					authUrl.searchParams.set('response_type', 'id_token');
					authUrl.searchParams.set('scope', 'openid email profile');
					authUrl.searchParams.set('nonce', nonce);

					const responseUrl = await browser.identity.launchWebAuthFlow({
						url: authUrl.toString(),
						interactive: true,
					});

					if (!responseUrl) throw new Error('No response from Google');

					const fragment = new URL(responseUrl).hash.substring(1);
					const params = new URLSearchParams(fragment);
					const idToken = params.get('id_token');
					if (!idToken) throw new Error('No id_token in response');

					const { data, error: authError } = await client.signIn.social({
						provider: 'google',
						idToken: { token: idToken, nonce },
					});
					if (authError)
						throw new Error(authError.message ?? authError.statusText);
					if (!data || !('user' in data))
						throw new Error('Unexpected response from server');
					const user = serializeDates(data.user);
					await authUser.set(user);
					return user;
				},
				catch: (cause) => {
					// User closed the popup — not an error worth displaying
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
				await refreshEncryptionKey();
			}

			return result;
		},

		/** Sign out — server-side invalidation + clear local state. */
		async signOut() {
			phase = { status: 'signing-out' };
			await encryption.wipe();
			await client.signOut().catch(() => {});
			await clearState().catch(() => {});
			phase = { status: 'signed-out' };
			return Ok(undefined);
		},

		/**
		 * Validate the stored session against the server.
		 *
		 * Waits for chrome.storage to load before reading the token so that
		 * fresh sidebar contexts (new windows) don't race past a still-undefined
		 * fallback value.
		 *
		 * Unreachable server (network error or 5xx) trusts the cached user
		 * so offline/degraded users aren't logged out. Only an explicit auth
		 * rejection (4xx) clears state.
		 */
		async checkSession() {
			await Promise.all([authToken.whenReady, authUser.whenReady]);

			const userId = authUser.current?.id;
			if (userId) {
				void encryption.restoreKeyFromCache(userId);
			}

			const token = authToken.current;
			if (!token) {
				phase = { status: 'signed-out' };
				return Ok(null);
			}

			const { data, error: sessionError } = await getSession();

			if (sessionError) {
				const isAuthRejection =
					sessionError.status && sessionError.status < 500;

				if (!isAuthRejection) {
					// Network error or 5xx → trust cached user
					const cached = authUser.current;
					phase = cached ? { status: 'signed-in' } : { status: 'signed-out' };
					return Ok(cached);
				}

				// 4xx → server explicitly rejected the token
				await clearState();
				await encryption.wipe();
				phase = { status: 'signed-out' };
				return Ok(null);
			}

			if (!data) {
				await clearState();
				phase = { status: 'signed-out' };
				return Ok(null);
			}

			const user = serializeDates(data.user);
			await authUser.set(user);
			if (data.encryptionKey) {
				await encryption.unlock(data.encryptionKey, data.user.id);
			}
			phase = { status: 'signed-in' };
			return Ok(user);
		},

		/**
		 * Subscribe to external sign-in events (e.g. sign-in from another extension context).
		 *
		 * When the auth token and user appear while this context is signed-out,
		 * the callback fires. Useful for triggering side effects like reconnecting
		 * sync without coupling those concerns to the auth module.
		 *
		 * @returns Unsubscribe function. Call in `onMount` cleanup.
		 *
		 * @example
		 * ```typescript
		 * onMount(() => {
		 *     return authState.onExternalSignIn(() => workspaceClient.extensions.sync.reconnect());
		 * });
		 * ```
		 */
		onExternalSignIn(callback: () => void) {
			externalSignInListeners.add(callback);
			return () => {
				externalSignInListeners.delete(callback);
			};
		},
	};
}

const keyManager = createKeyManager(workspaceClient, { keyCache });
export const authState = createAuthState(keyManager);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Convert all `Date` properties in an object to ISO strings. */
function serializeDates<T extends Record<string, unknown>>(obj: T) {
	return Object.fromEntries(
		Object.entries(obj).map(([key, value]) => [
			key,
			value instanceof Date ? value.toISOString() : value,
		]),
	) as { [K in keyof T]: T[K] extends Date ? string : T[K] };
}
