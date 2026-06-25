import { secrets } from 'bun';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Where a realm's OAuth token set lives, resolved once in config (see
 * `resolveTokenStore`). One value whose own shape is the discriminant: having a
 * `path` means a file; the bare `'keychain'` token means the OS keychain. So
 * "the keychain, at a file path" cannot be expressed.
 *
 * - A `0600` JSON file (the default) at `<data-dir>/credentials.json`, or
 *   wherever `LOCAL_BOOKS_KEYRING_FILE` points. Works identically on a desktop,
 *   a headless server, an SSH session, and CI, which is the property a tool
 *   whose recurring mode is unattended sync needs most.
 * - `'keychain'` (opt-in, `LOCAL_BOOKS_KEYRING=keychain`): the OS credential
 *   store. It cannot be reached from a session without a graphic security
 *   context (SSH, herdr), which is exactly why it is not the default.
 */
export type TokenStore = { readonly path: string } | 'keychain';

/**
 * A minimal secret store keyed by `realmId`. The OAuth token set is serialized
 * to JSON and stored here, never inside a company's mirror db (the agent's
 * read-only SQL surface must never be able to read it).
 *
 * Backend failures throw: an unreachable or locked credential store is fatal and
 * rare, so it bubbles to the top-level CLI handler (`bin.ts`) rather than
 * threading a Result through every caller. A throw means "store unreachable,"
 * never "no token stored" (which is a clean `null`). The two must not be
 * conflated: a locked keychain returned as `null` reads as "logged out" and
 * silently triggers a re-auth. See ADR-0061.
 */
export type Keyring = {
	readonly backend: string;
	get(account: string): Promise<string | null>;
	set(account: string, secret: string): Promise<void>;
	delete(account: string): Promise<void>;
};

const SERVICE = 'local-books';

/**
 * OS credential store via `Bun.secrets` (macOS Keychain, Linux libsecret,
 * Windows Credential Manager). Native, no subprocess, still inside the single
 * `bun build --compile` binary. `get` returns `null` only when nothing is
 * stored; a locked or unavailable store throws, by Bun's contract.
 */
export function createKeychainKeyring(): Keyring {
	return {
		backend: 'keychain',
		async get(account) {
			return secrets.get({ service: SERVICE, name: account });
		},
		async set(account, secret) {
			await secrets.set({ service: SERVICE, name: account, value: secret });
		},
		async delete(account) {
			await secrets.delete({ service: SERVICE, name: account });
		},
	};
}

/**
 * The default `0600` JSON-file store. The secret is not encrypted; the file mode
 * is the protection (the same tradeoff `git credential-store` and
 * `~/.aws/credentials` make). Kept out of any company's mirror db.
 */
export function createFileKeyring(filePath: string): Keyring {
	const load = (): Record<string, string> => {
		try {
			const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
			return typeof parsed === 'object' && parsed !== null ? parsed : {};
		} catch {
			return {};
		}
	};
	const save = (map: Record<string, string>) => {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, JSON.stringify(map, null, 2));
		chmodSync(filePath, 0o600);
	};
	return {
		backend: 'file',
		async get(account) {
			return load()[account] ?? null;
		},
		async set(account, secret) {
			const map = load();
			map[account] = secret;
			save(map);
		},
		async delete(account) {
			const map = load();
			delete map[account];
			save(map);
		},
	};
}

/** Process-lifetime in-memory store, for tests. */
export function createMemoryKeyring(): Keyring {
	const map = new Map<string, string>();
	return {
		backend: 'memory',
		async get(account) {
			return map.get(account) ?? null;
		},
		async set(account, secret) {
			map.set(account, secret);
		},
		async delete(account) {
			map.delete(account);
		},
	};
}

/** Open a resolved token store as a keyring. */
export function createKeyring(store: TokenStore): Keyring {
	return store === 'keychain'
		? createKeychainKeyring()
		: createFileKeyring(store.path);
}
