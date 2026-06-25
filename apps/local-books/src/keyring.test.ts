import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { createFileKeyring, createKeyring } from './keyring.ts';
import { credentialsFilePath } from './paths.ts';

function tempDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'local-books-keyring-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('createKeyring', () => {
	test('a path opens a 0600 file store at that path', async () => {
		const { dir, cleanup } = tempDir();
		try {
			const file = join(dir, 'credentials.json');
			const keyring = createKeyring({ path: file });
			expect(keyring.backend).toBe('file');

			await keyring.set('realm-1', 'secret-1');
			expect(readFileSync(file, 'utf8')).toContain('secret-1');
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(await keyring.get('realm-1')).toBe('secret-1');
		} finally {
			cleanup();
		}
	});

	test("'keychain' opens the OS keychain store", () => {
		expect(createKeyring('keychain').backend).toBe('keychain');
	});
});

describe('createFileKeyring', () => {
	test('round-trips and deletes a secret', async () => {
		const { dir, cleanup } = tempDir();
		try {
			const keyring = createFileKeyring(join(dir, 'credentials.json'));
			expect(await keyring.get('realm-1')).toBeNull();
			await keyring.set('realm-1', 'secret-1');
			expect(await keyring.get('realm-1')).toBe('secret-1');
			await keyring.delete('realm-1');
			expect(await keyring.get('realm-1')).toBeNull();
		} finally {
			cleanup();
		}
	});
});

describe('token store resolution', () => {
	const FILE = 'LOCAL_BOOKS_KEYRING_FILE';
	const BACKEND = 'LOCAL_BOOKS_KEYRING';

	/** Run `fn` with the two keyring env vars set to the given values, restored after. */
	function withEnv(
		values: { file?: string; backend?: string },
		fn: () => void,
	): void {
		const prev = { file: process.env[FILE], backend: process.env[BACKEND] };
		set(FILE, values.file);
		set(BACKEND, values.backend);
		try {
			fn();
		} finally {
			set(FILE, prev.file);
			set(BACKEND, prev.backend);
		}
	}
	function set(key: string, value: string | undefined): void {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	test('defaults to a file at <data-dir>/credentials.json', () => {
		withEnv({}, () => {
			const config = loadConfig({ dataDir: '/tmp/lb-resolve' });
			expect(config.tokenStore).toEqual({
				path: credentialsFilePath('/tmp/lb-resolve'),
			});
		});
	});

	test('opts into the keychain', () => {
		withEnv({ backend: 'keychain' }, () => {
			expect(loadConfig().tokenStore).toBe('keychain');
		});
	});

	test('an explicit file path wins over the keychain opt-in', () => {
		withEnv({ file: '/custom/creds.json', backend: 'keychain' }, () => {
			expect(loadConfig().tokenStore).toEqual({ path: '/custom/creds.json' });
		});
	});

	test('rejects an unknown backend value', () => {
		withEnv({ backend: 'bogus' }, () => {
			expect(() => loadConfig()).toThrow(/Unknown LOCAL_BOOKS_KEYRING/);
		});
	});
});
