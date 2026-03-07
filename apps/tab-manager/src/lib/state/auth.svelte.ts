/**
 * Auth state for the tab manager extension.
 *
 * Uses Better Auth's vanilla client (`createAuthClient`) with a custom token
 * bridge to `chrome.storage.local`. The client auto-injects Bearer tokens on
 * every request and captures new tokens from the `set-auth-token` header.
 *
 * Token storage is handled by `createStorageState`, which provides:
 * - Synchronous reads via `.current` (needed for the token getter)
 * - Reactive cross-context sync via `chrome.storage.onChanged`
 * - Schema validation on every read
 */

import { type } from 'arktype';
import { createAuthClient } from 'better-auth/client';
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
// Reactive State
// ─────────────────────────────────────────────────────────────────────────────

/** Reactive auth token. Read via `authToken.current`. */
export const authToken = createStorageState('local:authToken', {
	fallback: null,
	schema: type('string').or('null'),
});

/** Reactive auth user. Read via `authUser.current`. */
export const authUser = createStorageState('local:authUser', {
	fallback: null,
	schema: AuthUser.or('null'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Better Auth Client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Better Auth vanilla client.
 *
 * - `fetchOptions.auth.token` reads from `chrome.storage.local` synchronously
 * - `fetchOptions.onSuccess` captures rotated tokens from `set-auth-token` header
 * - `baseURL` uses the reactive `remoteServerUrl` fallback (stable for app lifetime)
 */
const auth = createAuthClient({
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
// Actions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sign in with email and password.
 *
 * Uses Better Auth's client to call the sign-in endpoint. The token is
 * captured from the `set-auth-token` response header via `onSuccess`.
 */
export async function signIn(email: string, password: string) {
	const { data, error } = await auth.signIn.email({ email, password });

	if (error) throw new Error(error.message ?? 'Sign-in failed');

	const { user } = data;
	await authUser.set(user);
	return user;
}

/** Sign out — server-side invalidation + clear local state. */
export async function signOut(): Promise<void> {
	// Best-effort server-side sign-out (client handles Bearer injection)
	await auth.signOut().catch(() => {});
	await Promise.all([authToken.set(null), authUser.set(null)]);
}

/**
 * Validate the stored session against the server.
 *
 * Offline-aware: if the server is unreachable (network error), trusts
 * the cached user rather than showing a sign-out screen. Only clears
 * state on an explicit auth rejection (4xx).
 */
export async function checkSession(): Promise<typeof AuthUser.infer | null> {
	const token = authToken.current;
	if (!token) return null;

	const { data, error } = await auth.getSession();

	if (error) {
		// Network error (fetch threw) → trust cached user
		if (!error.status) return authUser.current;

		// Server explicitly rejected the token → clear state
		await Promise.all([authToken.set(null), authUser.set(null)]);
		return null;
	}

	if (!data) {
		await Promise.all([authToken.set(null), authUser.set(null)]);
		return null;
	}

	const user = {
		id: data.user.id,
		email: data.user.email,
		name: data.user.name,
	};
	await authUser.set(user);
	return user;
}
