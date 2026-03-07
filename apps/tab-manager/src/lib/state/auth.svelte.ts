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
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

type AuthPhase =
	| { status: 'checking' }
	| { status: 'signing-in' }
	| { status: 'signing-out' }
	| { status: 'signed-in' }
	| { status: 'signed-out'; error?: string };

function createAuthState() {
	let phase = $state<AuthPhase>({ status: 'checking' });
	let email = $state('');
	let password = $state('');

	const client = $derived(
		createAuthClient({
			baseURL: remoteServerUrl.current,
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

	async function clearState() {
		await Promise.all([authToken.set(undefined), authUser.set(undefined)]);
	}

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
			phase = { status: 'signing-in' };

			const result = await tryAsync({
				try: async () => {
					const { data, error: authError } = await client.signIn.email({
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
				phase = { status: 'signed-out', error: result.error.message };
			} else {
				phase = { status: 'signed-in' };
				password = '';
			}

			return result;
		},

		/** Sign out — server-side invalidation + clear local state. */
		async signOut() {
			phase = { status: 'signing-out' };
			await client.signOut().catch(() => {});
			await clearState().catch(() => {});
			phase = { status: 'signed-out' };
			return Ok(undefined);
		},

		/**
		 * Validate the stored session against the server.
		 *
		 * Unreachable server (network error or 5xx) trusts the cached user
		 * so offline/degraded users aren't logged out. Only an explicit auth
		 * rejection (4xx) clears state.
		 */
		async checkSession() {
			const token = authToken.current;
			if (!token) {
				phase = { status: 'signed-out' };
				return Ok(null);
			}

			const { data, error: sessionError } = await client.getSession();

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
				phase = { status: 'signed-out' };
				return Ok(null);
			}

			if (!data) {
				await clearState();
				phase = { status: 'signed-out' };
				return Ok(null);
			}

			const { createdAt, updatedAt, ...rest } = data.user;
			const user = {
				...rest,
				createdAt: createdAt.toISOString(),
				updatedAt: updatedAt.toISOString(),
			} satisfies AuthUser;
			await authUser.set(user);
			phase = { status: 'signed-in' };
			return Ok(user);
		},

		/**
		 * Watch for token being cleared externally (e.g. another extension context).
		 * Call this inside a $effect.
		 */
		reactToTokenCleared() {
			if (!authToken.current && phase.status === 'signed-in') {
				void authUser.set(undefined);
				phase = { status: 'signed-out' };
			}
		},
	};
}

export const authState = createAuthState();
