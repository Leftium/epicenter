/**
 * Auth Unit Tests
 *
 * Tests for validateAuth function covering all auth modes and edge cases.
 * Co-located with auth.ts for easy discovery.
 */

import { describe, expect, test } from 'bun:test';
import { validateAuth } from './auth';

describe('validateAuth', () => {
	describe('open mode (no config)', () => {
		test('accepts connection with no token', async () => {
			const result = await validateAuth(undefined, undefined);
			expect(result).toBe(true);
		});

		test('accepts connection with any token', async () => {
			const result = await validateAuth(undefined, 'any-token');
			expect(result).toBe(true);
		});

		test('accepts connection with empty token', async () => {
			const result = await validateAuth(undefined, '');
			expect(result).toBe(true);
		});
	});

	describe('token mode', () => {
		test('accepts matching token', async () => {
			const config = { token: 'secret-key' };
			const result = await validateAuth(config, 'secret-key');
			expect(result).toBe(true);
		});

		test('rejects non-matching token', async () => {
			const config = { token: 'secret-key' };
			const result = await validateAuth(config, 'wrong-token');
			expect(result).toBe(false);
		});

		test('rejects missing token', async () => {
			const config = { token: 'secret-key' };
			const result = await validateAuth(config, undefined);
			expect(result).toBe(false);
		});

		test('rejects empty token when secret is configured', async () => {
			const config = { token: 'secret-key' };
			const result = await validateAuth(config, '');
			expect(result).toBe(false);
		});

		test('rejects empty string token (falsy check)', async () => {
			const config = { token: '' };
			const result = await validateAuth(config, '');
			expect(result).toBe(false);
		});

		test('is case-sensitive', async () => {
			const config = { token: 'Secret-Key' };
			const result = await validateAuth(config, 'secret-key');
			expect(result).toBe(false);
		});

		test('handles tokens with special characters', async () => {
			const config = { token: 'sk-proj-abc123!@#$%' };
			const result = await validateAuth(config, 'sk-proj-abc123!@#$%');
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

			await validateAuth({ verify }, 'test-token');
			expect(capturedToken).toBe('test-token');
		});

		test('returns true when verify returns true', async () => {
			const verify = () => true;
			const result = await validateAuth({ verify }, 'token');
			expect(result).toBe(true);
		});

		test('returns false when verify returns false', async () => {
			const verify = () => false;
			const result = await validateAuth({ verify }, 'token');
			expect(result).toBe(false);
		});

		test('does not call verify with missing token', async () => {
			let called = false;
			const verify = () => {
				called = true;
				return false;
			};

			await validateAuth({ verify }, undefined);
			expect(called).toBe(false);
		});

		test('verify receives token when provided', async () => {
			let capturedToken: string | undefined = 'not-set';
			const verify = (token: string) => {
				capturedToken = token;
				return false;
			};

			await validateAuth({ verify }, 'test-token');
			expect(capturedToken).toBe('test-token');
		});

		test('verify can implement custom logic', async () => {
			const verify = (token: string | undefined) => {
				return token?.startsWith('valid-') ?? false;
			};

			expect(await validateAuth({ verify }, 'valid-token')).toBe(true);
			expect(await validateAuth({ verify }, 'invalid-token')).toBe(false);
			expect(await validateAuth({ verify }, undefined)).toBe(false);
		});
	});

	describe('verify mode (async function)', () => {
		test('awaits async verify function', async () => {
			const verify = async () => {
				return new Promise<boolean>((resolve) => {
					setTimeout(() => resolve(true), 10);
				});
			};

			const result = await validateAuth({ verify }, 'token');
			expect(result).toBe(true);
		});

		test('returns false from async verify', async () => {
			const verify = async () => false;
			const result = await validateAuth({ verify }, 'token');
			expect(result).toBe(false);
		});

		test('async verify receives token correctly', async () => {
			let capturedToken: string | undefined;
			const verify = async (token: string | undefined) => {
				capturedToken = token;
				return true;
			};

			await validateAuth({ verify }, 'async-token');
			expect(capturedToken).toBe('async-token');
		});

		test('handles async verify with complex logic', async () => {
			const verify = async (token: string | undefined) => {
				// Simulate JWT validation or database lookup
				return new Promise<boolean>((resolve) => {
					setTimeout(() => {
						resolve(token === 'valid-jwt-token');
					}, 5);
				});
			};

			expect(await validateAuth({ verify }, 'valid-jwt-token')).toBe(true);
			expect(await validateAuth({ verify }, 'invalid-token')).toBe(false);
		});
	});

	describe('edge cases', () => {
		test('no token when auth is configured returns false', async () => {
			const config = { token: 'secret' };
			const result = await validateAuth(config, undefined);
			expect(result).toBe(false);
		});

		test('empty token when auth is configured returns false', async () => {
			const config = { token: 'secret' };
			const result = await validateAuth(config, '');
			expect(result).toBe(false);
		});

		test('whitespace-only token is treated as valid token', async () => {
			const config = { token: '   ' };
			const result = await validateAuth(config, '   ');
			expect(result).toBe(true);
		});

		test('very long token is handled correctly', async () => {
			const longToken = 'x'.repeat(10000);
			const config = { token: longToken };
			const result = await validateAuth(config, longToken);
			expect(result).toBe(true);
		});

		test('unicode tokens are handled correctly', async () => {
			const config = { token: 'token-🔐-secret' };
			const result = await validateAuth(config, 'token-🔐-secret');
			expect(result).toBe(true);
		});

		test('verify function can throw (caller responsibility)', async () => {
			const verify = () => {
				throw new Error('Verification failed');
			};

			try {
				await validateAuth({ verify }, 'token');
				expect.unreachable('Should have thrown');
			} catch (e) {
				expect(e).toBeInstanceOf(Error);
				expect((e as Error).message).toBe('Verification failed');
			}
		});
	});
});
