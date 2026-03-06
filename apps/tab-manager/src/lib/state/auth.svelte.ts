/**
 * Auth state for the tab manager extension.
 *
 * Stores a Better Auth session token and cached user info in
 * chrome.storage.local via @wxt-dev/storage, exposed as reactive
 * Svelte 5 state via `createExtensionState`.
 *
 * Sign-in flow:
 * 1. POST /auth/sign-in/email -> { token, user }
 * 2. Store token + user in chrome.storage.local
 * 3. Reactive state auto-syncs via .watch()
 * 4. Token read synchronously via authToken.current
 */

import { storage } from '@wxt-dev/storage';
import { remoteServerUrl } from './settings.svelte';
import { createExtensionState } from './extension-state.svelte';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AuthUser {
	id: string;
	email: string;
	name?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage Items
// ─────────────────────────────────────────────────────────────────────────────

const authTokenItem = storage.defineItem<string | null>('local:authToken', {
	fallback: null,
});

const authUserItem = storage.defineItem<AuthUser | null>('local:authUser', {
	fallback: null,
});

// ─────────────────────────────────────────────────────────────────────────────
// Reactive State
// ─────────────────────────────────────────────────────────────────────────────

/** Reactive auth token. Read via `authToken.current`. */
export const authToken = createExtensionState(authTokenItem);

/** Reactive auth user. Read via `authUser.current`. */
export const authUser = createExtensionState(authUserItem);

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
): Promise<AuthUser> {
	const res = await fetch(`${remoteServerUrl.current}/auth/sign-in/email`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password }),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Sign-in failed (${res.status}): ${body}`);
	}

	const data: { token: string; user: AuthUser } = await res.json();
	await Promise.all([
		authTokenItem.setValue(data.token),
		authUserItem.setValue(data.user),
	]);
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

	await Promise.all([
		authTokenItem.setValue(null),
		authUserItem.setValue(null),
	]);
}

/**
 * Validate the stored session against the server.
 *
 * Returns the user if the session is valid, or null (and clears storage)
 * if expired or invalid.
 */
export async function checkSession(): Promise<AuthUser | null> {
	const token = authToken.current;
	if (!token) return null;

	try {
		const res = await fetch(`${remoteServerUrl.current}/auth/get-session`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!res.ok) {
			await Promise.all([
				authTokenItem.setValue(null),
				authUserItem.setValue(null),
			]);
			return null;
		}

		const data: { user: AuthUser } = await res.json();
		await authUserItem.setValue(data.user);
		return data.user;
	} catch {
		return null;
	}
}
