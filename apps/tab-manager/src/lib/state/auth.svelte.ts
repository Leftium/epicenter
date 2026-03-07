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
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';
import { remoteServerUrl } from './settings.svelte';
import { createStorageState } from './storage-state.svelte';

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
// Better Auth Client
// ─────────────────────────────────────────────────────────────────────────────

let cachedClient: ReturnType<typeof createAuthClient> | null = null;
let cachedBaseUrl = '';

function getClient() {
	const url = remoteServerUrl.current;
	if (cachedClient && url === cachedBaseUrl) return cachedClient;

	cachedBaseUrl = url;
	cachedClient = createAuthClient({
		baseURL: url,
		fetchOptions: {
			auth: {
				type: 'Bearer',
				token: () => authToken.current,
			},
			onSuccess: (ctx) => {
				const newToken = ctx.response?.headers.get('set-auth-token');
				if (newToken) void authToken.set(newToken);
			},
		},
	});
	return cachedClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

type AuthStatus =
	| 'checking'
	| 'signing-in'
	| 'signing-out'
	| 'signed-in'
	| 'signed-out';

function createAuthState() {
	let status = $state<AuthStatus>('checking');
	let email = $state('');
	let password = $state('');
	let error = $state('');

	async function clearState() {
		await Promise.all([authToken.set(null), authUser.set(null)]);
	}

	return {
		get status(): AuthStatus {
			return status;
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
			status = 'signing-in';

			const result = await tryAsync({
				try: async () => {
					const { data, error: authError } = await getClient().signIn.email({
						email,
						password,
					});
					if (authError) throw new Error(authError.message ?? 'Sign-in failed');
					const { createdAt, updatedAt, ...rest } = data.user;
					const user = {
						...rest,
						createdAt: createdAt.toISOString(),
						updatedAt: updatedAt.toISOString(),
					} satisfies AuthUser;
					await authUser.set(user);
					return user;
				},
				catch: (cause) => AuthError.SignInFailed({ cause }),
			});

			if (result.error) {
				error = result.error.message;
				status = 'signed-out';
			} else {
				status = 'signed-in';
				password = '';
			}

			return result;
		},

		/** Sign out — server-side invalidation + clear local state. */
		async signOut() {
			status = 'signing-out';
			await getClient()
				.signOut()
				.catch(() => {});
			await clearState().catch(() => {});
			status = 'signed-out';
			return Ok(undefined);
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

			const { data, error: sessionError } = await getClient().getSession();

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

			const { createdAt, updatedAt, ...rest } = data.user;
			const user = {
				...rest,
				createdAt: createdAt.toISOString(),
				updatedAt: updatedAt.toISOString(),
			} satisfies AuthUser;
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
				void authUser.set(null);
				status = 'signed-out';
			}
		},
	};
}

export const authState = createAuthState();
