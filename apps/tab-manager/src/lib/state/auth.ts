/**
 * Auth state for the tab manager extension.
 *
 * Stores a Better Auth session token and cached user info in
 * chrome.storage.local via @wxt-dev/storage. Mirrors the CLI's
 * auth pattern (packages/cli/src/auth-store.ts) but uses extension
 * storage instead of the filesystem.
 *
 * Sign-in flow:
 * 1. POST /auth/sign-in/email → { token, user }
 * 2. Store token + user in chrome.storage.local
 * 3. Sync extension reads token via getAuthToken() in its getToken callback
 * 4. Token passed as ?token=xyz on WebSocket upgrade
 */

import { storage } from '@wxt-dev/storage';
import { getRemoteServerUrl } from './settings';

// ─────────────────────────────────────────────────────────────────────────────
// Storage Items
// ─────────────────────────────────────────────────────────────────────────────

interface AuthUser {
	id: string;
	email: string;
	name?: string;
}

const authTokenItem = storage.defineItem<string | null>('local:authToken', {
	fallback: null,
});

const authUserItem = storage.defineItem<AuthUser | null>('local:authUser', {
	fallback: null,
});

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Get the stored auth token, or null if not signed in. */
export async function getAuthToken(): Promise<string | null> {
	return authTokenItem.getValue();
}

/** Get the stored user info, or null if not signed in. */
export async function getAuthUser(): Promise<AuthUser | null> {
	return authUserItem.getValue();
}

/**
 * Sign in with email and password.
 *
 * Calls Better Auth's email sign-in endpoint and stores the session token.
 * Returns the user on success, or throws on failure.
 */
export async function signIn(
	email: string,
	password: string,
): Promise<AuthUser> {
	const remoteUrl = await getRemoteServerUrl();
	const res = await fetch(`${remoteUrl}/auth/sign-in/email`, {
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
	const remoteUrl = await getRemoteServerUrl();
	const token = await getAuthToken();

	// Best-effort server-side sign out
	if (token) {
		fetch(`${remoteUrl}/auth/sign-out`, {
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
	const token = await getAuthToken();
	if (!token) return null;

	const remoteUrl = await getRemoteServerUrl();
	try {
		const res = await fetch(`${remoteUrl}/auth/get-session`, {
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

/** Watch for auth token changes. */
export function watchAuthToken(callback: (token: string | null) => void) {
	return authTokenItem.watch(callback);
}
