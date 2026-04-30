/**
 * Auth session store backed by `$EPICENTER_HOME/auth/sessions.json`.
 *
 * This is a Node/Bun runtime helper used by the CLI, daemon hosts, and scripts.
 * It lives outside `@epicenter/cli` because daemons need the same machine-local
 * session without depending on the yargs CLI package.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
	EncryptionKeys,
	type EncryptionKeys as EncryptionKeysData,
} from '../document/encryption-key.js';
import { epicenterPaths } from './epicenter-paths.js';

export type AuthSession = {
	accessToken: string;
	expiresAt: number;
	encryptionKeys: EncryptionKeysData;
	user?: { id: string; email: string; name?: string };
};

export type SaveSessionData = {
	encryptionKeys: EncryptionKeysData;
	user?: { id: string; email: string; name?: string };
};

function normalizeUrl(url: string): string {
	return url
		.replace(/^wss:/, 'https:')
		.replace(/^ws:/, 'http:')
		.replace(/\/+$/, '')
		.toLowerCase();
}

export function createSessionStore() {
	const path = epicenterPaths.authSessions();

	type Store = Record<string, AuthSession>;

	function parseUser(value: unknown): AuthSession['user'] {
		if (value == null || typeof value !== 'object') return undefined;
		const record = value as Record<string, unknown>;
		if (typeof record.id !== 'string') return undefined;
		if (typeof record.email !== 'string') return undefined;
		return {
			id: record.id,
			email: record.email,
			name: typeof record.name === 'string' ? record.name : undefined,
		};
	}

	function parseStore(value: unknown): Store {
		if (value == null || typeof value !== 'object' || Array.isArray(value)) {
			return {};
		}

		const store: Store = {};
		for (const [server, session] of Object.entries(value)) {
			if (session == null || typeof session !== 'object') continue;
			const record = session as Record<string, unknown>;
			if (typeof record.accessToken !== 'string') continue;
			if (typeof record.expiresAt !== 'number') continue;

			let encryptionKeys: EncryptionKeysData;
			try {
				encryptionKeys = EncryptionKeys.assert(record.encryptionKeys);
			} catch {
				continue;
			}

			store[server] = {
				accessToken: record.accessToken,
				expiresAt: record.expiresAt,
				encryptionKeys,
				user: parseUser(record.user),
			};
		}
		return store;
	}

	async function read(): Promise<Store> {
		const file = Bun.file(path);
		if (!(await file.exists())) return {};
		try {
			return parseStore(await file.json());
		} catch {
			return {};
		}
	}

	async function write(store: Store): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		await Bun.write(path, JSON.stringify(store, null, '\t'));
	}

	return {
		async save(
			server: string,
			token: { access_token: string; expires_in: number },
			sessionData: SaveSessionData,
		): Promise<void> {
			const store = await read();
			const key = normalizeUrl(server);
			delete store[key];
			store[key] = {
				accessToken: token.access_token,
				expiresAt: Date.now() + token.expires_in * 1000,
				encryptionKeys: sessionData.encryptionKeys,
				user: sessionData.user,
			};
			await write(store);
		},

		async load(
			server: string,
		): Promise<(AuthSession & { server: string }) | null> {
			const store = await read();
			const key = normalizeUrl(server);
			const session = store[key];
			return session ? { ...session, server: key } : null;
		},

		async loadDefault(): Promise<(AuthSession & { server: string }) | null> {
			const store = await read();
			const entries = Object.entries(store);
			if (entries.length === 0) return null;
			const lastEntry = entries[entries.length - 1];
			if (!lastEntry) return null;
			const [server, session] = lastEntry;
			return { ...session, server };
		},

		async clear(server: string): Promise<void> {
			const store = await read();
			delete store[normalizeUrl(server)];
			await write(store);
		},
	};
}

export type SessionStore = ReturnType<typeof createSessionStore>;
