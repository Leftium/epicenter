/**
 * Encryption Primitive Tests
 *
 * Verifies the generic crypto helpers that protect encrypted storage and key
 * derivation. These tests pin the blob format, key derivation, keyring codec,
 * and key equality contracts owned by this package.
 *
 * Key behaviors:
 * - XChaCha20-Poly1305 round trips plaintext and rejects tampering
 * - Key versions stay inside the one-byte encrypted blob range
 * - Keyring parsing canonicalizes order and rejects ambiguous inputs
 * - Derivation helpers stay deterministic and Web Crypto compatible
 */

import { describe, expect, test } from 'bun:test';
import { randomBytes } from '@noble/ciphers/utils.js';
import {
	base64ToBytes,
	buildEncryptionKeys,
	bytesToBase64,
	decryptValue,
	deriveKeyFromPassword,
	deriveUserEncryptionKeys,
	deriveWorkspaceKey,
	type EncryptedBlob,
	encryptionKeysEqual,
	encryptValue,
	formatEncryptionSecrets,
	generateSalt,
	getKeyVersion,
	isEncryptedBlob,
	PBKDF2_ITERATIONS_DEFAULT,
	parseEncryptionSecrets,
} from './index.js';

async function deriveWorkspaceKeyWithWebCrypto(
	userKey: Uint8Array,
	workspaceId: string,
): Promise<Uint8Array> {
	const hkdfKey = await crypto.subtle.importKey(
		'raw',
		new Uint8Array(userKey).buffer,
		'HKDF',
		false,
		['deriveBits'],
	);
	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(0),
			info: new TextEncoder().encode(`workspace:${workspaceId}`),
		},
		hkdfKey,
		256,
	);
	return new Uint8Array(derivedBits);
}

describe('encryptValue and decryptValue', () => {
	test('encrypt then decrypt returns original string', () => {
		const key = randomBytes(32);
		const plaintext = JSON.stringify({ id: '123', active: true });
		const encrypted = encryptValue(plaintext, key);

		expect(decryptValue(encrypted, key)).toBe(plaintext);
		expect(encrypted).toBeInstanceOf(Uint8Array);
		expect(encrypted[0]).toBe(1);
		expect(encrypted[1]).toBe(1);
		expect(encrypted.length).toBeGreaterThanOrEqual(42);
	});

	test('each encryption uses a fresh nonce', () => {
		const key = randomBytes(32);
		const plaintext = 'same plaintext';
		const encrypted1 = encryptValue(plaintext, key);
		const encrypted2 = encryptValue(plaintext, key);

		expect(encrypted1).not.toEqual(encrypted2);
		expect(decryptValue(encrypted1, key)).toBe(plaintext);
		expect(decryptValue(encrypted2, key)).toBe(plaintext);
	});

	test('custom key version is embedded at byte 1', () => {
		const key = randomBytes(32);
		const encrypted = encryptValue('test', key, undefined, 7);

		expect(encrypted[1]).toBe(7);
		expect(getKeyVersion(encrypted)).toBe(7);
	});

	test('key versions outside 1 to 255 throw before writing blob header', () => {
		const key = randomBytes(32);

		expect(() => encryptValue('test', key, undefined, 0)).toThrow();
		expect(() => encryptValue('test', key, undefined, 256)).toThrow();
		expect(() => buildEncryptionKeys(key, 0)).toThrow();
		expect(() => buildEncryptionKeys(key, 256)).toThrow();
	});

	test('invalid key size throws', () => {
		expect(() => encryptValue('test', new Uint8Array(16))).toThrow();
	});

	test('tampered ciphertext throws', () => {
		const key = randomBytes(32);
		const encrypted = encryptValue('test', key);
		const tampered = new Uint8Array(encrypted);
		tampered[26] = (tampered[26] as number) ^ 0xff;

		expect(() => decryptValue(tampered as EncryptedBlob, key)).toThrow();
	});

	test('mismatched AAD throws', () => {
		const key = randomBytes(32);
		const encrypted = encryptValue(
			'secret',
			key,
			new TextEncoder().encode('entry:a'),
		);

		expect(() =>
			decryptValue(encrypted, key, new TextEncoder().encode('entry:b')),
		).toThrow();
	});
});

describe('isEncryptedBlob', () => {
	test('returns true for encrypted blobs', () => {
		expect(isEncryptedBlob(encryptValue('test', randomBytes(32)))).toBe(true);
	});

	test('returns false for non-byte arrays, short byte arrays, and wrong format byte', () => {
		expect(isEncryptedBlob(null)).toBe(false);
		expect(isEncryptedBlob({})).toBe(false);
		expect(isEncryptedBlob(new Uint8Array(41))).toBe(false);
		expect(isEncryptedBlob(new Uint8Array(42))).toBe(false);
	});
});

describe('base64 helpers', () => {
	test('bytesToBase64 then base64ToBytes returns original bytes', () => {
		const original = new Uint8Array(256);
		for (let i = 0; i < 256; i++) original[i] = i;

		expect(base64ToBytes(bytesToBase64(original))).toEqual(original);
	});

	test('base64ToBytes handles standard base64 strings', () => {
		const decoded = base64ToBytes('SGVsbG8gV29ybGQ=');

		expect(new TextDecoder().decode(decoded)).toBe('Hello World');
	});
});

describe('deriveWorkspaceKey', () => {
	test('same inputs produce same key and different labels produce different keys', () => {
		const userKey = randomBytes(32);

		expect(deriveWorkspaceKey(userKey, 'tab-manager')).toEqual(
			deriveWorkspaceKey(userKey, 'tab-manager'),
		);
		expect(deriveWorkspaceKey(userKey, 'tab-manager')).not.toEqual(
			deriveWorkspaceKey(userKey, 'whispering'),
		);
	});

	test('matches Web Crypto HKDF output for fixed fixtures', async () => {
		const fixtures = [
			{
				userKey: base64ToBytes('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='),
				workspaceId: 'tab-manager',
			},
			{
				userKey: base64ToBytes('8PHy8/T19vf4+fr7/P3+/wABAgMEBQYHCAkKCwwNDg8='),
				workspaceId: 'workspace:with:colons',
			},
		];

		for (const fixture of fixtures) {
			expect(deriveWorkspaceKey(fixture.userKey, fixture.workspaceId)).toEqual(
				await deriveWorkspaceKeyWithWebCrypto(
					fixture.userKey,
					fixture.workspaceId,
				),
			);
		}
	});
});

describe('deriveKeyFromPassword and generateSalt', () => {
	test('password derivation is deterministic for the same salt', () => {
		const salt = randomBytes(32);

		expect(deriveKeyFromPassword('hunter2', salt)).toEqual(
			deriveKeyFromPassword('hunter2', salt),
		);
		expect(deriveKeyFromPassword('hunter2', salt)).not.toEqual(
			deriveKeyFromPassword('password2', salt),
		);
		expect(PBKDF2_ITERATIONS_DEFAULT).toBe(600_000);
	});

	test('generateSalt returns fresh 32 byte salts', () => {
		const salt1 = generateSalt();
		const salt2 = generateSalt();

		expect(salt1.length).toBe(32);
		expect(salt2.length).toBe(32);
		expect(salt1).not.toEqual(salt2);
	});
});

describe('buildEncryptionKeys and encryptionKeysEqual', () => {
	test('buildEncryptionKeys returns transport keys that round trip through base64', () => {
		const userKey = randomBytes(32);
		const keys = buildEncryptionKeys(userKey, 3);

		expect(keys).toEqual([
			{ version: 3, userKeyBase64: bytesToBase64(userKey) },
		]);
		expect(base64ToBytes(keys[0].userKeyBase64)).toEqual(userKey);
	});

	test('encryptionKeysEqual ignores order and compares key material', () => {
		const keyV1 = bytesToBase64(randomBytes(32));
		const keyV2 = bytesToBase64(randomBytes(32));

		expect(
			encryptionKeysEqual(
				[
					{ version: 1, userKeyBase64: keyV1 },
					{ version: 2, userKeyBase64: keyV2 },
				],
				[
					{ version: 2, userKeyBase64: keyV2 },
					{ version: 1, userKeyBase64: keyV1 },
				],
			),
		).toBe(true);
		expect(
			encryptionKeysEqual(
				[{ version: 1, userKeyBase64: keyV1 }],
				[{ version: 1, userKeyBase64: keyV2 }],
			),
		).toBe(false);
	});
});

describe('parseEncryptionSecrets and formatEncryptionSecrets', () => {
	test('parseEncryptionSecrets sorts versions descending', () => {
		expect(parseEncryptionSecrets('1:old,3:new,2:middle')).toEqual([
			{ version: 3, secret: 'new' },
			{ version: 2, secret: 'middle' },
			{ version: 1, secret: 'old' },
		]);
	});

	test('formatEncryptionSecrets emits canonical descending order', () => {
		expect(
			formatEncryptionSecrets([
				{ version: 1, secret: 'old' },
				{ version: 2, secret: 'new' },
			]),
		).toBe('2:new,1:old');
	});

	test('secret values may contain colons', () => {
		expect(parseEncryptionSecrets('1:secret:with:colons')).toEqual([
			{ version: 1, secret: 'secret:with:colons' },
		]);
	});

	test('round trip preserves canonical representation', () => {
		const formatted = formatEncryptionSecrets(
			parseEncryptionSecrets('1:old,2:new'),
		);

		expect(formatted).toBe('2:new,1:old');
	});

	test('malformed entries throw', () => {
		expect(() => parseEncryptionSecrets('')).toThrow();
		expect(() => parseEncryptionSecrets('1')).toThrow();
		expect(() => parseEncryptionSecrets(':secret')).toThrow();
		expect(() => parseEncryptionSecrets('1:')).toThrow();
		expect(() => parseEncryptionSecrets('1:secret,with,comma')).toThrow();
	});

	test('duplicate versions and out of range versions throw', () => {
		expect(() => parseEncryptionSecrets('2:alpha,2:bravo')).toThrow();
		expect(() => parseEncryptionSecrets('0:secret')).toThrow();
		expect(() => parseEncryptionSecrets('256:secret')).toThrow();
		expect(() =>
			formatEncryptionSecrets([
				{ version: 1, secret: 'a' },
				{ version: 1, secret: 'b' },
			]),
		).toThrow();
	});
});

describe('deriveUserEncryptionKeys', () => {
	test('derives one transport key for every secret version', async () => {
		const keys = await deriveUserEncryptionKeys({
			secrets: parseEncryptionSecrets('2:new,1:old'),
			userId: 'user-1',
		});

		expect(keys).toHaveLength(2);
		expect(keys[0]?.version).toBe(2);
		expect(keys[1]?.version).toBe(1);
		expect(base64ToBytes(keys[0]?.userKeyBase64 ?? '').length).toBe(32);
	});

	test('same secrets and user id derive the same transport keys', async () => {
		const input = {
			secrets: parseEncryptionSecrets('1:secret'),
			userId: 'user-1',
		};

		expect(await deriveUserEncryptionKeys(input)).toEqual(
			await deriveUserEncryptionKeys(input),
		);
	});
});
