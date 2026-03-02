/**
 * Auth Unit Tests
 *
 * Tests for validateAuth function covering all auth modes and edge cases.
 * Co-located with auth.ts for easy discovery.
 */

import { describe, expect, test } from 'bun:test';
import { openAuth, tokenAuth, validateAuth, verifyAuth } from './auth';

describe('validateAuth', () => {
	describe('open mode (no config)', () => {
		test('accepts connection with no token', async () => {
			const result = await validateAuth(openAuth(), undefined);
			expect(result).toBe(true);
		});

		test('accepts connection with any token', async () => {
			const result = await validateAuth(openAuth(), 'any-token');
			expect(result).toBe(true);
		});

		test('accepts connection with empty token', async () => {
			const result = await validateAuth(openAuth(), '');
			expect(result).toBe(true);
		});
	});

	describe('token mode', () => {
		test('accepts matching token', async () => {
			const result = await validateAuth(tokenAuth('secret-key'), 'secret-key');
			expect(result).toBe(true);
		});

		test('rejects non-matching token', async () => {
			const result = await validateAuth(tokenAuth('secret-key'), 'wrong-token');
			expect(result).toBe(false);
		});

		test('rejects missing token', async () => {
			const result = await validateAuth(tokenAuth('secret-key'), undefined);
			expect(result).toBe(false);
		});

		test('rejects empty token when secret is configured', async () => {
			const result = await validateAuth(tokenAuth('secret-key'), '');
			expect(result).toBe(false);
		});

		test('empty string token matches empty string config (undefined check, not falsy)', async () => {
			// The new implementation uses `token !== undefined` — empty string is not undefined,
			// so an empty-string bearer matches an empty-string token config.
			const result = await validateAuth(tokenAuth(''), '');
			expect(result).toBe(true);
		});

		test('is case-sensitive', async () => {
			const result = await validateAuth(tokenAuth('Secret-Key'), 'secret-key');
			expect(result).toBe(false);
		});

		test('handles tokens with special characters', async () => {
			const result = await validateAuth(
				tokenAuth('sk-proj-abc123!@#$%'),
				'sk-proj-abc123!@#$%',
			);
			expect(result).toBe(true);
		});
	});

	describe('verify mode (sync function)', () => {
		test('calls verify function with token', async () => {
			let capturedToken: string | undefined;
			const verify = (token: string) => {
				capturedToken = token;
				return true;
			};

			await validateAuth(verifyAuth(verify), 'test-token');
			expect(capturedToken).toBe('test-token');
		});

		test('returns true when verify returns true', async () => {
			const result = await validateAuth(verifyAuth(() => true), 'token');
			expect(result).toBe(true);
		});

		test('returns false when verify returns false', async () => {
			const result = await validateAuth(verifyAuth(() => false), 'token');
			expect(result).toBe(false);
		});

		test('does not call verify with missing token', async () => {
			let called = false;
			const verify = () => {
				called = true;
				return false;
			};

			await validateAuth(verifyAuth(verify), undefined);
			expect(called).toBe(false);
		});

		test('verify receives token when provided', async () => {
			let capturedToken: string | undefined = 'not-set';
			const verify = (token: string) => {
				capturedToken = token;
				return false;
			};

			await validateAuth(verifyAuth(verify), 'test-token');
			expect(capturedToken).toBe('test-token');
		});

		test('verify can implement custom logic', async () => {
			const verify = (token: string) => token.startsWith('valid-');

			expect(await validateAuth(verifyAuth(verify), 'valid-token')).toBe(true);
			expect(await validateAuth(verifyAuth(verify), 'invalid-token')).toBe(
				false,
			);
			expect(await validateAuth(verifyAuth(verify), undefined)).toBe(false);
		});
	});

	describe('verify mode (async function)', () => {
		test('awaits async verify function', async () => {
			const verify = async () => {
				return new Promise<boolean>((resolve) => {
					setTimeout(() => resolve(true), 10);
				});
			};

			const result = await validateAuth(verifyAuth(verify), 'token');
			expect(result).toBe(true);
		});

		test('returns false from async verify', async () => {
			const result = await validateAuth(verifyAuth(async () => false), 'token');
			expect(result).toBe(false);
		});

		test('async verify receives token correctly', async () => {
			let capturedToken: string | undefined;
			const verify = async (token: string) => {
				capturedToken = token;
				return true;
			};

			await validateAuth(verifyAuth(verify), 'async-token');
			expect(capturedToken).toBe('async-token');
		});

		test('handles async verify with complex logic', async () => {
			const verify = async (token: string) => {
				// Simulate JWT validation or database lookup
				return new Promise<boolean>((resolve) => {
					setTimeout(() => {
						resolve(token === 'valid-jwt-token');
					}, 5);
				});
			};

			expect(await validateAuth(verifyAuth(verify), 'valid-jwt-token')).toBe(
				true,
			);
			expect(await validateAuth(verifyAuth(verify), 'invalid-token')).toBe(
				false,
			);
		});
	});

	describe('edge cases', () => {
		test('no token when auth is configured returns false', async () => {
			const result = await validateAuth(tokenAuth('secret'), undefined);
			expect(result).toBe(false);
		});

		test('empty token when auth is configured returns false', async () => {
			const result = await validateAuth(tokenAuth('secret'), '');
			expect(result).toBe(false);
		});

		test('whitespace-only token is treated as valid token', async () => {
			const result = await validateAuth(tokenAuth('   '), '   ');
			expect(result).toBe(true);
		});

		test('very long token is handled correctly', async () => {
			const longToken = 'x'.repeat(10000);
			const result = await validateAuth(tokenAuth(longToken), longToken);
			expect(result).toBe(true);
		});

		test('unicode tokens are handled correctly', async () => {
			const result = await validateAuth(
				tokenAuth('token-🔐-secret'),
				'token-🔐-secret',
			);
			expect(result).toBe(true);
		});

		test('verify function can throw (caller responsibility)', async () => {
			const verify = () => {
				throw new Error('Verification failed');
			};

			try {
				await validateAuth(verifyAuth(verify), 'token');
				expect.unreachable('Should have thrown');
			} catch (e) {
				expect(e).toBeInstanceOf(Error);
				expect((e as Error).message).toBe('Verification failed');
			}
		});
	});
});
