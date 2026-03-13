import { describe, expect, test } from 'bun:test';
import {
	base64ToBytes,
	bytesToBase64,
	decryptValue,
	deriveKeyFromPassword,
	deriveSalt,
	type EncryptedBlob,
	encryptValue,
	generateEncryptionKey,
	isEncryptedBlob,
} from './index';

describe('generateEncryptionKey', () => {
	test('returns 32-byte Uint8Array', () => {
		const key = generateEncryptionKey();
		expect(key).toBeInstanceOf(Uint8Array);
		expect(key.length).toBe(32);
	});

	test('two generated keys are different', () => {
		const key1 = generateEncryptionKey();
		const key2 = generateEncryptionKey();
		expect(key1).not.toEqual(key2);
	});
});

describe('encryptValue / decryptValue', () => {
	test('round-trip: encrypt then decrypt returns original string', () => {
		const key = generateEncryptionKey();
		const plaintext = 'Hello, World!';
		const encrypted = encryptValue(plaintext, key);
		const decrypted = decryptValue(encrypted, key);
		expect(decrypted).toBe(plaintext);
	});

	test('round-trip with empty string', () => {
		const key = generateEncryptionKey();
		const plaintext = '';
		const encrypted = encryptValue(plaintext, key);
		const decrypted = decryptValue(encrypted, key);
		expect(decrypted).toBe(plaintext);
	});

	test('round-trip with unicode characters', () => {
		const key = generateEncryptionKey();
		const plaintext = '你好世界 🌍 مرحبا بالعالم';
		const encrypted = encryptValue(plaintext, key);
		const decrypted = decryptValue(encrypted, key);
		expect(decrypted).toBe(plaintext);
	});

	test('round-trip with JSON string', () => {
		const key = generateEncryptionKey();
		const plaintext = JSON.stringify({ id: '123', name: 'Test', active: true });
		const encrypted = encryptValue(plaintext, key);
		const decrypted = decryptValue(encrypted, key);
		expect(decrypted).toBe(plaintext);
	});

	test('round-trip with long string', () => {
		const key = generateEncryptionKey();
		const plaintext = 'a'.repeat(10000);
		const encrypted = encryptValue(plaintext, key);
		const decrypted = decryptValue(encrypted, key);
		expect(decrypted).toBe(plaintext);
	});

	test('each encrypt produces different ciphertext (unique IV per call)', () => {
		const key = generateEncryptionKey();
		const plaintext = 'Same plaintext';
		const encrypted1 = encryptValue(plaintext, key);
		const encrypted2 = encryptValue(plaintext, key);

		// Different IVs should produce different ciphertexts
		expect(encrypted1.ct).not.toBe(encrypted2.ct);
		expect(encrypted1.iv).not.toBe(encrypted2.iv);

		// But both should decrypt to the same plaintext
		expect(decryptValue(encrypted1, key)).toBe(plaintext);
		expect(decryptValue(encrypted2, key)).toBe(plaintext);
	});

	test('encrypted blob has correct shape', () => {
		const key = generateEncryptionKey();
		const encrypted = encryptValue('test', key);

		expect(encrypted).toHaveProperty('v');
		expect(encrypted).toHaveProperty('alg');
		expect(encrypted).toHaveProperty('ct');
		expect(encrypted).toHaveProperty('iv');

		expect(encrypted.v).toBe(1);
		expect(encrypted.alg).toBe('A256GCM');
		expect(typeof encrypted.ct).toBe('string');
		expect(typeof encrypted.iv).toBe('string');
	});

	test('invalid key (16-byte instead of 32) throws', () => {
		const invalidKey = new Uint8Array(16); // Wrong size
		const plaintext = 'test';

		expect(() => {
			encryptValue(plaintext, invalidKey);
		}).toThrow();
	});

	test('tampered ciphertext throws', () => {
		const key = generateEncryptionKey();
		const encrypted = encryptValue('test', key);

		// Flip a character in the ciphertext
		const tamperedCt = encrypted.ct.split('').reverse().join('');
		const tamperedBlob: EncryptedBlob = {
			...encrypted,
			ct: tamperedCt,
		};

		expect(() => {
			decryptValue(tamperedBlob, key);
		}).toThrow();
	});

	test('tampered IV throws', () => {
		const key = generateEncryptionKey();
		const encrypted = encryptValue('test', key);

		// Flip a character in the IV
		const tamperedIv = encrypted.iv.split('').reverse().join('');
		const tamperedBlob: EncryptedBlob = {
			...encrypted,
			iv: tamperedIv,
		};

		expect(() => {
			decryptValue(tamperedBlob, key);
		}).toThrow();
	});
});

describe('isEncryptedBlob', () => {
	test('returns true for valid EncryptedBlob', () => {
		const key = generateEncryptionKey();
		const blob = encryptValue('test', key);
		expect(isEncryptedBlob(blob)).toBe(true);
	});

	test('returns false for null', () => {
		expect(isEncryptedBlob(null)).toBe(false);
	});

	test('returns false for undefined', () => {
		expect(isEncryptedBlob(undefined)).toBe(false);
	});

	test('returns false for string', () => {
		expect(isEncryptedBlob('not a blob')).toBe(false);
	});

	test('returns false for number', () => {
		expect(isEncryptedBlob(42)).toBe(false);
	});

	test('returns false for plain object', () => {
		expect(isEncryptedBlob({})).toBe(false);
	});

	test('returns false for object with wrong v', () => {
		const blob = {
			v: 2, // Wrong version
			alg: 'A256GCM',
			ct: 'ciphertext',
			iv: 'nonce',
		};
		expect(isEncryptedBlob(blob)).toBe(false);
	});

	test('returns false for object with wrong alg', () => {
		const blob = {
			v: 1,
			alg: 'AES-256-CBC', // Wrong algorithm
			ct: 'ciphertext',
			iv: 'nonce',
		};
		expect(isEncryptedBlob(blob)).toBe(false);
	});

	test('returns false for object missing ct field', () => {
		const blob = {
			v: 1,
			alg: 'A256GCM',
			iv: 'nonce',
		};
		expect(isEncryptedBlob(blob)).toBe(false);
	});

	test('returns false for object missing iv field', () => {
		const blob = {
			v: 1,
			alg: 'A256GCM',
			ct: 'ciphertext',
		};
		expect(isEncryptedBlob(blob)).toBe(false);
	});

	test('returns false for object with non-string ct', () => {
		const blob = {
			v: 1,
			alg: 'A256GCM',
			ct: 12345, // Should be string
			iv: 'nonce',
		};
		expect(isEncryptedBlob(blob)).toBe(false);
	});

	test('returns false for object with non-string iv', () => {
		const blob = {
			v: 1,
			alg: 'A256GCM',
			ct: 'ciphertext',
			iv: 12345, // Should be string
		};
		expect(isEncryptedBlob(blob)).toBe(false);
	});
});

describe('deriveKeyFromPassword', () => {
	test('same password + salt produces same key', async () => {
		const password = 'myPassword123';
		const salt = new Uint8Array(16);
		salt.fill(42);

		const key1 = await deriveKeyFromPassword(password, salt);
		const key2 = await deriveKeyFromPassword(password, salt);

		expect(key1).toEqual(key2);
	});

	test('different passwords produce different keys', async () => {
		const salt = new Uint8Array(16);
		salt.fill(42);

		const key1 = await deriveKeyFromPassword('password1', salt);
		const key2 = await deriveKeyFromPassword('password2', salt);

		expect(key1).not.toEqual(key2);
	});

	test('different salts produce different keys', async () => {
		const password = 'myPassword123';
		const salt1 = new Uint8Array(16);
		salt1.fill(42);
		const salt2 = new Uint8Array(16);
		salt2.fill(99);

		const key1 = await deriveKeyFromPassword(password, salt1);
		const key2 = await deriveKeyFromPassword(password, salt2);

		expect(key1).not.toEqual(key2);
	});

	test('returns 32-byte Uint8Array', async () => {
		const password = 'test';
		const salt = new Uint8Array(16);
		const key = await deriveKeyFromPassword(password, salt);

		expect(key).toBeInstanceOf(Uint8Array);
		expect(key.length).toBe(32);
	});
});

describe('deriveSalt', () => {
	test('deterministic: same userId + workspaceId = same salt', async () => {
		const userId = 'user123';
		const workspaceId = 'workspace456';

		const salt1 = await deriveSalt(userId, workspaceId);
		const salt2 = await deriveSalt(userId, workspaceId);

		expect(salt1).toEqual(salt2);
	});

	test('different userId = different salt', async () => {
		const workspaceId = 'workspace456';

		const salt1 = await deriveSalt('user1', workspaceId);
		const salt2 = await deriveSalt('user2', workspaceId);

		expect(salt1).not.toEqual(salt2);
	});

	test('different workspaceId = different salt', async () => {
		const userId = 'user123';

		const salt1 = await deriveSalt(userId, 'workspace1');
		const salt2 = await deriveSalt(userId, 'workspace2');

		expect(salt1).not.toEqual(salt2);
	});

	test('returns 16-byte Uint8Array', async () => {
		const salt = await deriveSalt('user123', 'workspace456');

		expect(salt).toBeInstanceOf(Uint8Array);
		expect(salt.length).toBe(16);
	});
});

describe('base64 helpers', () => {
	test('round-trip: bytesToBase64 then base64ToBytes returns original', () => {
		const original = new Uint8Array([1, 2, 3, 255, 0, 127, 128]);
		const base64 = bytesToBase64(original);
		const decoded = base64ToBytes(base64);

		expect(decoded).toEqual(original);
	});

	test('handles empty Uint8Array', () => {
		const original = new Uint8Array([]);
		const base64 = bytesToBase64(original);
		const decoded = base64ToBytes(base64);

		expect(decoded).toEqual(original);
		expect(decoded.length).toBe(0);
	});

	test('handles byte value 0', () => {
		const original = new Uint8Array([0, 0, 0]);
		const base64 = bytesToBase64(original);
		const decoded = base64ToBytes(base64);

		expect(decoded).toEqual(original);
	});

	test('handles byte value 255', () => {
		const original = new Uint8Array([255, 255, 255]);
		const base64 = bytesToBase64(original);
		const decoded = base64ToBytes(base64);

		expect(decoded).toEqual(original);
	});

	test('handles all byte values 0-255', () => {
		const original = new Uint8Array(256);
		for (let i = 0; i < 256; i++) {
			original[i] = i;
		}

		const base64 = bytesToBase64(original);
		const decoded = base64ToBytes(base64);

		expect(decoded).toEqual(original);
	});

	test('bytesToBase64 produces valid base64 string', () => {
		const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
		const base64 = bytesToBase64(bytes);

		// Valid base64 should only contain alphanumeric, +, /, and = for padding
		expect(/^[A-Za-z0-9+/]*={0,2}$/.test(base64)).toBe(true);
	});

	test('base64ToBytes handles standard base64 strings', () => {
		const base64 = 'SGVsbG8gV29ybGQ='; // "Hello World"
		const decoded = base64ToBytes(base64);
		const text = new TextDecoder().decode(decoded);

		expect(text).toBe('Hello World');
	});
});
