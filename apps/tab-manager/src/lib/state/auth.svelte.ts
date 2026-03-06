/**
 * Auth state for the tab manager extension.
 *
 * Stores a Better Auth session token and cached user info in
 * chrome.storage.local, exposed as reactive Svelte 5 state via
 * `createExtensionState` with schema validation.
 *
 * Sign-in flow:
 * 1. POST /auth/sign-in/email -> { token, user }
 * 2. Store token + user in chrome.storage.local
 * 3. Reactive state auto-syncs via .watch()
 * 4. Token read synchronously via authToken.current
 */

import { type } from 'arktype';
import { createExtensionState } from './extension-state.svelte';
import { remoteServerUrl } from './settings.svelte';

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
export const authToken = createExtensionState('local:authToken', {
	fallback: null,
	schema: type('string').or('null'),
});

/** Reactive auth user. Read via `authUser.current`. */
export const authUser = createExtensionState('local:authUser', {
	fallback: null,
	schema: AuthUser.or('null'),
});

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sign in with email and password.
 *
 * Calls Better Auth's email sign-in endpoint and stores the session token.
 * Reactive state auto-updates via `.watch()`.
 */
export async function signIn(
	email: string,
	password: string,
): Promise<typeof AuthUser.infer> {
	const res = await fetch(`${remoteServerUrl.current}/auth/sign-in/email`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password }),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Sign-in failed (${res.status}): ${body}`);
	}

	const data: { token: string; user: typeof AuthUser.infer } = await res.json();
	await Promise.all([authToken.set(data.token), authUser.set(data.user)]);
	return data.user;
}

/** Sign out — clears stored token and user. */
export async function signOut(): Promise<void> {
	const token = authToken.current;

	// Best-effort server-side sign out
	if (token) {
		fetch(`${remoteServerUrl.current}/auth/sign-out`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
		}).catch(() => {});
	}

	await Promise.all([authToken.set(null), authUser.set(null)]);
}

/**
 * Validate the stored session against the server.
 *
 * Returns the user if the session is valid, or null (and clears storage)
 * if expired or invalid.
 */
export async function checkSession(): Promise<typeof AuthUser.infer | null> {
	const token = authToken.current;
	if (!token) return null;

	try {
		const res = await fetch(`${remoteServerUrl.current}/auth/get-session`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!res.ok) {
			await Promise.all([authToken.set(null), authUser.set(null)]);
			return null;
		}

		const data: { user: typeof AuthUser.infer } = await res.json();
		await authUser.set(data.user);
		return data.user;
	} catch {
		return null;
	}
}
