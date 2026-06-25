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

describe('createKeyring resolution', () => {
	test('defaults to a 0600 file at <data-dir>/credentials.json', async () => {
		const { dir, cleanup } = tempDir();
		try {
			const keyring = createKeyring({
				keyringBackend: 'file',
				keyringFile: null,
				dataDir: dir,
			});
			expect(keyring.backend).toBe('file');

			await keyring.set('realm-1', 'secret-1');
			const file = credentialsFilePath(dir);
			expect(readFileSync(file, 'utf8')).toContain('secret-1');
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(await keyring.get('realm-1')).toBe('secret-1');
		} finally {
			cleanup();
		}
	});

	test('an explicit keyringFile wins over the keychain opt-in', async () => {
		const { dir, cleanup } = tempDir();
		try {
			const file = join(dir, 'custom.json');
			const keyring = createKeyring({
				keyringBackend: 'keychain',
				keyringFile: file,
				dataDir: dir,
			});
			expect(keyring.backend).toBe('file');

			await keyring.set('realm-1', 'secret-1');
			expect(readFileSync(file, 'utf8')).toContain('secret-1');
		} finally {
			cleanup();
		}
	});

	test('opts into the OS keychain only when asked and no file path is set', () => {
		const keyring = createKeyring({
			keyringBackend: 'keychain',
			keyringFile: null,
			dataDir: '/tmp/local-books-unused',
		});
		expect(keyring.backend).toBe('keychain');
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

describe('LOCAL_BOOKS_KEYRING resolution', () => {
	const KEY = 'LOCAL_BOOKS_KEYRING';
	function withEnv(value: string | undefined, fn: () => void): void {
		const prev = process.env[KEY];
		if (value === undefined) delete process.env[KEY];
		else process.env[KEY] = value;
		try {
			fn();
		} finally {
			if (prev === undefined) delete process.env[KEY];
			else process.env[KEY] = prev;
		}
	}

	test('defaults to the file backend', () => {
		withEnv(undefined, () => {
			expect(loadConfig().keyringBackend).toBe('file');
		});
	});

	test('opts into the keychain backend', () => {
		withEnv('keychain', () => {
			expect(loadConfig().keyringBackend).toBe('keychain');
		});
	});

	test('rejects an unknown value', () => {
		withEnv('bogus', () => {
			expect(() => loadConfig()).toThrow(/Unknown LOCAL_BOOKS_KEYRING/);
		});
	});
});
