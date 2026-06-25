import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A minimal secret store keyed by `realmId`. The OAuth token set is serialized
 * to JSON and stored here, never inside a company's mirror db (the agent's
 * read-only SQL surface must never be able to read it).
 *
 * Backend failures throw: an unreachable store is fatal and rare, so it bubbles
 * to the top-level CLI handler (`bin.ts`) rather than threading a Result through
 * every caller. A throw means "store unreachable," never "no token stored"
 * (which is a clean `null`); conflating the two would read a transient failure
 * as "logged out" and silently trigger a re-auth. See ADR-0061.
 */
export type Keyring = {
	readonly backend: string;
	get(account: string): Promise<string | null>;
	set(account: string, secret: string): Promise<void>;
	delete(account: string): Promise<void>;
};

/**
 * The `0600` JSON-file token store at `<data-dir>/credentials.json` (or wherever
 * `LOCAL_BOOKS_KEYRING_FILE` points). The secret is not encrypted; the file mode
 * is the protection, the same tradeoff `git credential-store` and
 * `~/.aws/credentials` make. Works identically on a desktop, a headless server,
 * an SSH session, and CI, which is the property a tool whose recurring mode is
 * unattended sync needs most. Kept out of any company's mirror db. See ADR-0061.
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
