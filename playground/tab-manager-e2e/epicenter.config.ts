/**
 * E2E test config: syncs the tab-manager workspace from the Epicenter API
 * down to local persistence (SQLite .db file) with encryption.
 *
 * Mirrors the tab-manager extension's client setup:
 *   1. Persistence — SQLite append-log for Y.Doc state
 *   2. Sync — WebSocket to the Epicenter API
 *   3. Encryption — keys fetched from API, cached locally
 *
 * On first run, fetches encryption keys from the API (using the CLI auth
 * token) and caches them locally. Subsequent runs read from cache and call
 * `applyEncryptionKeys()` immediately — no network roundtrip needed.
 *
 * Usage:
 *   epicenter start playground/tab-manager-e2e --verbose
 *   epicenter list savedTabs -C playground/tab-manager-e2e
 */

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTabManagerWorkspace } from '@epicenter/tab-manager/workspace';
import type { EncryptionKeys } from '@epicenter/workspace';
import {
	markdownMaterializer,
	titleFilenameSerializer,
} from '@epicenter/workspace/extensions/materializer/markdown';
import { filesystemPersistence } from '@epicenter/workspace/extensions/persistence/sqlite';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync/websocket';

const SERVER_URL = 'https://api.epicenter.so';
const SESSIONS_PATH = join(homedir(), '.epicenter', 'auth', 'sessions.json');
const PERSISTENCE_DIR = join(import.meta.dir, '.epicenter', 'persistence');
const MARKDOWN_DIR = join(import.meta.dir, 'data');
const KEY_CACHE_PATH = join(
	import.meta.dir,
	'.epicenter',
	'encryption-keys.json',
);

// ─── Auth helpers ────────────────────────────────────────────────────────────

/** Read the access token from the CLI auth store (~/.epicenter/auth/sessions.json). */
async function getAccessToken(): Promise<string | null> {
	try {
		const file = Bun.file(SESSIONS_PATH);
		if (!(await file.exists())) return null;
		const store = (await file.json()) as Record<
			string,
			{ accessToken: string }
		>;
		return store[SERVER_URL]?.accessToken ?? null;
	} catch {
		return null;
	}
}

/**
 * Load encryption keys — reads from local cache first, falls back to API fetch.
 *
 * Handles both API response formats:
 *   - Current deployed: `{ encryptionKey: string, keyVersion: number }`
 *   - Future (in repo): `{ encryptionKeys: [{ version, userKeyBase64 }] }`
 */
async function loadEncryptionKeys(): Promise<EncryptionKeys | null> {
	// Try local cache first
	try {
		const file = Bun.file(KEY_CACHE_PATH);
		if (await file.exists()) {
			const cached = (await file.json()) as EncryptionKeys;
			if (cached?.length) return cached;
		}
	} catch {
		// Cache miss — fall through to API fetch
	}

	// No cache — fetch from API
	const token = await getAccessToken();
	if (!token) return null;

	try {
		const res = await fetch(`${SERVER_URL}/auth/get-session`, {
			headers: { authorization: `Bearer ${token}` },
		});
		if (!res.ok) return null;
		const data = (await res.json()) as {
			// Future format (array)
			encryptionKeys?: Array<{ version: number; userKeyBase64: string }>;
			// Current deployed format (singular)
			encryptionKey?: string;
			keyVersion?: number;
		};

		// Normalize to array format
		const keys: EncryptionKeys | null =
			(data.encryptionKeys as EncryptionKeys) ??
			(data.encryptionKey && data.keyVersion
				? [{ version: data.keyVersion, userKeyBase64: data.encryptionKey }]
				: null);

		if (!keys?.length) return null;

		// Cache for next run
		await mkdir(dirname(KEY_CACHE_PATH), { recursive: true });
		await Bun.write(KEY_CACHE_PATH, JSON.stringify(keys));

		return keys;
	} catch {
		return null;
	}
}

// ─── Workspace client ────────────────────────────────────────────────────────

export const tabManager = createTabManagerWorkspace()
	.withExtension(
		'persistence',
		filesystemPersistence({
			filePath: join(PERSISTENCE_DIR, 'epicenter.tab-manager.db'),
		}),
	)
	.withWorkspaceExtension(
		'markdown',
		markdownMaterializer({
			directory: MARKDOWN_DIR,
			tables: {
				savedTabs: { serializer: titleFilenameSerializer('title') },
				bookmarks: { serializer: titleFilenameSerializer('title') },
				devices: {},
			},
		}),
	)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (docId) => `${SERVER_URL}/workspaces/${docId}`,
			getToken: async () => getAccessToken(),
		}),
	);

// Apply encryption keys from cache or API (async boot — fine for CLI)
loadEncryptionKeys().then((keys) => {
	if (keys) tabManager.applyEncryptionKeys(keys);
});
