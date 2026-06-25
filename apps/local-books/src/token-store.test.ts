import { describe, expect, test } from 'bun:test';
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { credentialsFilePath } from './paths.ts';
import { createFileTokenStore } from './token-store.ts';
import type { TokenSet } from './tokens.ts';

function tempDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), 'local-books-token-store-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const token: TokenSet = {
	realmId: 'realm-1',
	environment: 'sandbox',
	accessToken: 'access-1',
	refreshToken: 'refresh-1',
	accessTokenExpiresAt: '2026-02-01T01:00:00.000Z',
	refreshTokenExpiresAt: '2026-05-12T00:00:00.000Z',
	obtainedAt: '2026-02-01T00:00:00.000Z',
};

describe('createFileTokenStore', () => {
	test('writes a 0600 file and round-trips a token set', async () => {
		const { dir, cleanup } = tempDir();
		try {
			const file = join(dir, 'credentials.json');
			const store = createFileTokenStore(file);

			expect(await store.get('realm-1')).toBeNull();
			await store.set(token);
			expect(readFileSync(file, 'utf8')).toContain('access-1');
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(await store.get('realm-1')).toEqual(token);
		} finally {
			cleanup();
		}
	});

	test('treats a malformed on-disk entry as absent', async () => {
		const { dir, cleanup } = tempDir();
		try {
			// A token entry missing required fields must not deserialize to a partial
			// TokenSet: the untrusted-disk boundary validates and reports "no token".
			const file = join(dir, 'credentials.json');
			writeFileSync(
				file,
				JSON.stringify({ 'realm-1': JSON.stringify({ realmId: 'realm-1' }) }),
			);
			expect(await createFileTokenStore(file).get('realm-1')).toBeNull();
		} finally {
			cleanup();
		}
	});
});

describe('credentials path resolution', () => {
	const FILE = 'LOCAL_BOOKS_TOKEN_FILE';

	/** Run `fn` with `LOCAL_BOOKS_TOKEN_FILE` set to `file`, restored after. */
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

	test('an explicit LOCAL_BOOKS_TOKEN_FILE wins', () => {
		withFileEnv('/custom/creds.json', () => {
			expect(loadConfig().credentialsPath).toBe('/custom/creds.json');
		});
	});
});
