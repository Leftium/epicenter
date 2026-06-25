import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { createFileKeyring } from './keyring.ts';
import { credentialsFilePath } from './paths.ts';

function tempDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'local-books-keyring-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('createFileKeyring', () => {
	test('writes a 0600 file and round-trips a secret', async () => {
		const { dir, cleanup } = tempDir();
		try {
			const file = join(dir, 'credentials.json');
			const keyring = createFileKeyring(file);

			expect(await keyring.get('realm-1')).toBeNull();
			await keyring.set('realm-1', 'secret-1');
			expect(readFileSync(file, 'utf8')).toContain('secret-1');
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(await keyring.get('realm-1')).toBe('secret-1');
		} finally {
			cleanup();
		}
	});
});

describe('credentials path resolution', () => {
	const FILE = 'LOCAL_BOOKS_KEYRING_FILE';

	/** Run `fn` with `LOCAL_BOOKS_KEYRING_FILE` set to `file`, restored after. */
	function withFileEnv(file: string | undefined, fn: () => void): void {
		const prev = process.env[FILE];
		if (file === undefined) delete process.env[FILE];
		else process.env[FILE] = file;
		try {
			fn();
		} finally {
			if (prev === undefined) delete process.env[FILE];
			else process.env[FILE] = prev;
		}
	}

	test('defaults to a file at <data-dir>/credentials.json', () => {
		withFileEnv(undefined, () => {
			const config = loadConfig({ dataDir: '/tmp/lb-resolve' });
			expect(config.credentialsPath).toBe(
				credentialsFilePath('/tmp/lb-resolve'),
			);
		});
	});

	test('an explicit LOCAL_BOOKS_KEYRING_FILE wins', () => {
		withFileEnv('/custom/creds.json', () => {
			expect(loadConfig().credentialsPath).toBe('/custom/creds.json');
		});
	});
});
