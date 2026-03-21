/**
 * Unified auth session store.
 *
 * Stores auth sessions keyed by server URL at `$EPICENTER_HOME/auth/sessions.json`.
 * Supports multiple simultaneous server sessions.
 *
 * Token resolution order:
 * 1. `EPICENTER_TOKEN` env var (CI/scripts override)
 * 2. Stored session for the given server URL
 * 3. `undefined` (unauthenticated / open mode)
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type AuthSession = {
	/** The server this session authenticates against. */
	server: string;
	/** Bearer token for API/WebSocket auth. */
	accessToken: string;
	/** Unix ms when the session was created. */
	createdAt: number;
	/** Token lifetime in seconds (from the server). */
	expiresIn: number;
	/** User info (if available from the auth flow). */
	user?: { id: string; email: string; name?: string };
};

type SessionStore = Record<string, AuthSession>;

function sessionsPath(home: string): string {
	return join(home, 'auth', 'sessions.json');
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
 * Overwrites any existing session for the same server URL.
 */
export async function saveSession(
	home: string,
	session: AuthSession,
): Promise<void> {
	const store = await readStore(home);
	store[session.server] = session;
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
	return store[server] ?? null;
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
	delete store[server];
	await writeStore(home, store);
}

/**
 * Delete all stored sessions.
 */
export async function clearAllSessions(home: string): Promise<void> {
	await writeStore(home, {});
}

/**
 * Resolve an auth token for a given server.
 *
 * Resolution order:
 * 1. `EPICENTER_TOKEN` env var (CI/scripts)
 * 2. Stored session for `server`
 * 3. Most recent session (if `server` is undefined)
 * 4. `undefined`
 */
export async function resolveToken(
	home: string,
	server?: string,
): Promise<string | undefined> {
	if (process.env.EPICENTER_TOKEN) return process.env.EPICENTER_TOKEN;

	if (server) {
		const session = await loadSession(home, server);
		return session?.accessToken;
	}

	const session = await loadDefaultSession(home);
	return session?.accessToken;
}

/**
 * Resolve the server URL from the session store.
 *
 * If `server` is provided, returns it as-is.
 * Otherwise returns the server from the most recent session.
 */
export async function resolveServer(
	home: string,
	server?: string,
): Promise<string | undefined> {
	if (server) return server;
	const session = await loadDefaultSession(home);
	return session?.server;
}
