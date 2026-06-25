import { secrets } from 'bun';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from './config.ts';
import { credentialsFilePath } from './paths.ts';

/**
 * A minimal secret store keyed by `realmId`. The OAuth token set is serialized
 * to JSON and stored here, never inside a company's mirror db (the agent's
 * read-only SQL surface must never be able to read it). Backends:
 *
 * - **file** (the default): a `0600` JSON file at `<data-dir>/credentials.json`,
 *   or wherever `LOCAL_BOOKS_KEYRING_FILE` points. Works identically on a
 *   desktop, a headless server, an SSH session, and CI, which is the property a
 *   tool whose recurring mode is unattended sync needs most. Plaintext at rest;
 *   filesystem permissions are the protection, the same tradeoff `git
 *   credential-store` and `~/.aws/credentials` make.
 * - **keychain** (opt-in, `LOCAL_BOOKS_KEYRING=keychain`): the OS credential
 *   store via `Bun.secrets` (macOS Keychain, Linux libsecret, Windows Credential
 *   Manager). Native, no subprocess, still inside the single `bun build
 *   --compile` binary. It cannot be reached from a session without a graphic
 *   security context (SSH, herdr), which is exactly why it is not the default.
 * - **memory**: process-lifetime, for tests.
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
 * OS credential store via `Bun.secrets`. Opt-in (`LOCAL_BOOKS_KEYRING=keychain`)
 * because it needs a graphic security session: a headless, SSH, or herdr shell
 * cannot reach it. `get` returns `null` only when nothing is stored; a locked or
 * unavailable store throws, by Bun's contract.
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
 * is the protection. Kept out of any company's mirror db so the agent's
 * read-only SQL surface never sees it.
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

/**
 * Resolve the token store. An explicit `LOCAL_BOOKS_KEYRING_FILE` wins (it names
 * a concrete file: CI, tests, a custom location); then the opt-in keychain; else
 * the default `0600` file at `<data-dir>/credentials.json`.
 */
export function createKeyring(
	config: Pick<AppConfig, 'keyringBackend' | 'keyringFile' | 'dataDir'>,
): Keyring {
	if (config.keyringFile) return createFileKeyring(config.keyringFile);
	if (config.keyringBackend === 'keychain') return createKeychainKeyring();
	return createFileKeyring(credentialsFilePath(config.dataDir));
}
