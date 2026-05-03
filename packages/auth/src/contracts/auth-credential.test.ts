import { describe, expect, test } from 'bun:test';
import { normalizeAuthCredential } from './auth-credential.ts';

describe('normalizeAuthCredential', () => {
	test('normalizes Better Auth Date fields into the portable credential', () => {
		const createdAt = new Date('2026-01-01T00:00:00.000Z');
		const updatedAt = new Date('2026-01-02T00:00:00.000Z');
		const expiresAt = new Date('2026-02-01T00:00:00.000Z');

		const credential = normalizeAuthCredential(
			{
				user: {
					id: 'user-1',
					name: 'User One',
					email: 'user@example.com',
					emailVerified: true,
					image: null,
					createdAt,
					updatedAt,
				},
				session: {
					id: 'session-1',
					token: 'session-token',
					userId: 'user-1',
					expiresAt,
					createdAt,
					updatedAt,
					ipAddress: null,
					userAgent: null,
				},
				encryptionKeys: [
					{
						version: 1,
						userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
					},
				],
			},
			{
				serverOrigin: 'https://api.epicenter.so',
				authorizationToken: 'authorization-token',
			},
		);

		expect(credential.serverOrigin).toBe('https://api.epicenter.so');
		expect(credential.authorizationToken).toBe('authorization-token');
		expect(credential.user.createdAt).toBe(createdAt.toISOString());
		expect(credential.serverSession.expiresAt).toBe(expiresAt.toISOString());
	});
});
