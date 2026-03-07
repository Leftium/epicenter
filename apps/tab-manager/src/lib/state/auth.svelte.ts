/**
 * Auth state singleton for the tab manager extension.
 *
 * Co-locates all auth-related reactive state (session, form fields, loading)
 * and actions (signIn, signOut, checkSession) in a single module.
 *
 * All actions return Result types — they never throw.
 */

import { type } from 'arktype';
import { createAuthClient } from 'better-auth/client';
import { defineErrors, extractErrorMessage, type InferErrors } from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';
import { remoteServerUrl } from './settings.svelte';
import { createStorageState } from './storage-state.svelte';

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const AuthUser = type({
	id: 'string',
	email: 'string',
	'name?': 'string',
});

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

export const AuthError = defineErrors({
	SignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Sign-in failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignOutFailed: ({ cause }: { cause: unknown }) => ({
		message: `Sign-out failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SessionCheckFailed: ({ cause }: { cause: unknown }) => ({
		message: `Session check failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AuthError = InferErrors<typeof AuthError>;

// ─────────────────────────────────────────────────────────────────────────────
// Persisted State (cross-context via chrome.storage)
// ─────────────────────────────────────────────────────────────────────────────

/** Reactive auth token. Read via `authToken.current`. */
const authToken = createStorageState('local:authToken', {
	fallback: null,
	schema: type('string').or('null'),
});

/** Reactive auth user. Read via `authUser.current`. */
const authUser = createStorageState('local:authUser', {
	fallback: null,
	schema: AuthUser.or('null'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Better Auth Client
// ─────────────────────────────────────────────────────────────────────────────

const client = createAuthClient({
	baseURL: remoteServerUrl.current,
	fetchOptions: {
		auth: {
			type: 'Bearer',
			token: () => authToken.current ?? '',
		},
		onSuccess: (ctx) => {
			const newToken = ctx.response?.headers.get('set-auth-token');
			if (newToken) void authToken.set(newToken);
		},
	},
});

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

type AuthStatus = 'checking' | 'signed-out' | 'signed-in';

function createAuthState() {
	let status = $state<AuthStatus>('checking');
	let email = $state('');
	let password = $state('');
	let error = $state('');
	let isSigningIn = $state(false);
	let isSigningOut = $state(false);

	async function clearState() {
		await Promise.all([authToken.set(null), authUser.set(null)]);
	}

	return {
		get status() {
			return status;
		},
		set status(value: AuthStatus) {
			status = value;
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
		get error() {
			return error;
		},
		set error(value: string) {
			error = value;
		},
		get isSigningIn() {
			return isSigningIn;
		},
		get isSigningOut() {
			return isSigningOut;
		},
		get user() {
			return authUser.current;
		},
		get token() {
			return authToken.current;
		},

		/**
		 * Sign in with the current email and password form state.
		 * Manages loading/error state internally.
		 */
		async signIn() {
			error = '';
			isSigningIn = true;

			const result = await tryAsync({
				try: async () => {
					const { data, error: authError } = await client.signIn.email({
						email,
						password,
					});
					if (authError) throw new Error(authError.message ?? 'Sign-in failed');
					await authUser.set(data.user);
					return data.user;
				},
				catch: (cause) => AuthError.SignInFailed({ cause }),
			});

			if (result.error) {
				error = result.error.message;
			} else {
				status = 'signed-in';
				password = '';
			}

			isSigningIn = false;
			return result;
		},

		/** Sign out — server-side invalidation + clear local state. */
		async signOut() {
			isSigningOut = true;

			const result = await tryAsync({
				try: async () => {
					await client.signOut().catch(() => {});
					await clearState();
				},
				catch: (cause) => AuthError.SignOutFailed({ cause }),
			});

			// Always transition to signed-out, even on error
			status = 'signed-out';
			isSigningOut = false;
			return result;
		},

		/**
		 * Validate the stored session against the server.
		 *
		 * Offline-aware: if the server is unreachable (network error), trusts
		 * the cached user rather than showing a sign-out screen. Only clears
		 * state on an explicit auth rejection (4xx).
		 */
		async checkSession() {
			const token = authToken.current;
			if (!token) {
				status = 'signed-out';
				return Ok(null);
			}

			const { data, error: sessionError } = await client.getSession();

			if (sessionError) {
				// Network error (fetch threw) → trust cached user
				if (!sessionError.status) {
					const cached = authUser.current;
					status = cached ? 'signed-in' : 'signed-out';
					return Ok(cached);
				}

				// Server explicitly rejected the token → clear state
				await clearState();
				status = 'signed-out';
				return Ok(null);
			}

			if (!data) {
				await clearState();
				status = 'signed-out';
				return Ok(null);
			}

			const user = {
				id: data.user.id,
				email: data.user.email,
				name: data.user.name,
			};
			await authUser.set(user);
			status = 'signed-in';
			return Ok(user);
		},

		/**
		 * Watch for token being cleared externally (e.g. another extension context).
		 * Call this inside a $effect.
		 */
		reactToTokenCleared() {
			if (!authToken.current && status === 'signed-in') {
				status = 'signed-out';
			}
		},
	};
}

export const authState = createAuthState();
