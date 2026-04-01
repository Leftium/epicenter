/**
 * Unified auth session store.
 *
 * Stores auth sessions keyed by server URL at `$EPICENTER_HOME/auth/sessions.json`.
 * Supports multiple simultaneous server sessions.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type AuthSession = {
	/** Canonical server URL (always `https://` or `http://`, lowercased, no trailing slash). */
	server: string;
	/** Bearer token for API/WebSocket auth. */
	accessToken: string;
	/** Unix ms when the session was created. */
	createdAt: number;
	/** Token lifetime in seconds (from the server). */
	expiresIn: number;
	/** User info (if available from the auth flow). */
	user?: { id: string; email: string; name?: string };
	/** Base64-encoded user encryption key for workspace decryption. */
	userKeyBase64?: string;
};

type SessionStore = Record<string, AuthSession>;

function sessionsPath(home: string): string {
	return join(home, 'auth', 'sessions.json');
}

/**
 * Canonicalize a server URL to its HTTPS form.
 *
 * The canonical form is always `https://` (or `http://` for plaintext),
 * lowercased, with no trailing slash. This is the form used as the session
 * store key and for HTTP API calls.
 *
 * - `wss://API.epicenter.so/` → `https://api.epicenter.so`
 * - `ws://localhost:3913` → `http://localhost:3913`
 * - `https://api.epicenter.so/` → `https://api.epicenter.so`
 *
 * @example
 * ```typescript
 * normalizeServerUrl('wss://api.epicenter.so/');
 * // → 'https://api.epicenter.so'
 * ```
 */
export function normalizeServerUrl(url: string): string {
	return url
		.replace(/^wss:/, 'https:')
		.replace(/^ws:/, 'http:')
		.replace(/\/+$/, '')
		.toLowerCase();
}

/**
 * Load all stored sessions from disk.
 *
 * Returns an empty record if the file doesn't exist or is corrupt.
 */
async function readStore(home: string): Promise<SessionStore> {
	const file = Bun.file(sessionsPath(home));
	if (!(await file.exists())) return {};
	try {
		return (await file.json()) as SessionStore;
	} catch {
		return {};
	}
}

/** Write the full session store to disk. */
async function writeStore(home: string, store: SessionStore): Promise<void> {
	const path = sessionsPath(home);
	await mkdir(dirname(path), { recursive: true });
	await Bun.write(path, JSON.stringify(store, null, '\t'));
}

/**
 * Save a session for a server.
 *
 * The server URL is canonicalized before storage so that `wss://host`,
 * `https://host`, and `https://host/` all map to the same entry.
 */
export async function saveSession(
	home: string,
	session: AuthSession,
): Promise<void> {
	const store = await readStore(home);
	const canonicalServer = normalizeServerUrl(session.server);
	store[canonicalServer] = { ...session, server: canonicalServer };
	await writeStore(home, store);
}

/**
 * Load a session for a specific server.
 *
 * @returns The stored session, or `null` if none exists.
 */
export async function loadSession(
	home: string,
	server: string,
): Promise<AuthSession | null> {
	const store = await readStore(home);
	return store[normalizeServerUrl(server)] ?? null;
}

/**
 * Load the most recent session (any server).
 *
 * Used when no `--server` flag is provided — returns the session
 * with the latest `createdAt` timestamp.
 *
 * @returns The most recent session, or `null` if no sessions exist.
 */
export async function loadDefaultSession(
	home: string,
): Promise<AuthSession | null> {
	const store = await readStore(home);
	const sessions = Object.values(store);
	if (sessions.length === 0) return null;
	return sessions.reduce((latest, s) =>
		s.createdAt > latest.createdAt ? s : latest,
	);
}

/**
 * Delete the session for a specific server.
 */
export async function clearSession(
	home: string,
	server: string,
): Promise<void> {
	const store = await readStore(home);
	delete store[normalizeServerUrl(server)];
	await writeStore(home, store);
}
