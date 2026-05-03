/**
 * Auth Session Contract Tests
 *
 * Verifies normalization at the Better Auth boundary before auth state reaches
 * local session storage.
 *
 * Key behaviors:
 * - Better Auth Date fields become portable ISO strings
 * - Custom session responses normalize into app sessions
 * - Invalid key payloads fail at the auth contract boundary
 */

import { describe, expect, test } from 'bun:test';
import type { EncryptionKeys } from '@epicenter/encryption';
import {
	authSessionFromBetterAuthSessionResponse,
	normalizeAuthSession,
} from './auth-session.ts';

const encryptionKeys: EncryptionKeys = [
	{
		version: 1,
		userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
];

function betterAuthSessionResponse() {
	const createdAt = new Date('2026-01-01T00:00:00.000Z');
	const updatedAt = new Date('2026-01-02T00:00:00.000Z');
	const expiresAt = new Date('2026-02-01T00:00:00.000Z');

	return {
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
		encryptionKeys,
	};
}

describe('normalizeAuthSession', () => {
	test('normalizes Better Auth Date fields into the local session', () => {
		const response = betterAuthSessionResponse();

		const session = normalizeAuthSession(response, {
			token: 'authorization-token',
		});

		expect(session.token).toBe('authorization-token');
		expect(session.user.createdAt).toBe(response.user.createdAt.toISOString());
		expect(JSON.stringify(session)).not.toContain('expiresAt');
	});
});

describe('authSessionFromBetterAuthSessionResponse', () => {
	test('projects Better Auth custom session response into app session', () => {
		const response = betterAuthSessionResponse();

		const session = authSessionFromBetterAuthSessionResponse(response);

		expect(session).toEqual({
			token: 'session-token',
			user: {
				id: 'user-1',
				name: 'User One',
				email: 'user@example.com',
				emailVerified: true,
				image: null,
				createdAt: response.user.createdAt.toISOString(),
				updatedAt: response.user.updatedAt.toISOString(),
			},
			encryptionKeys,
		});
	});

	test('returns null for signed-out Better Auth session response', () => {
		expect(authSessionFromBetterAuthSessionResponse(null)).toBeNull();
		expect(authSessionFromBetterAuthSessionResponse(undefined)).toBeNull();
	});

	test('throws when custom session response omits encryption keys', () => {
		const response = betterAuthSessionResponse();

		expect(() =>
			authSessionFromBetterAuthSessionResponse({
				user: response.user,
				session: response.session,
			}),
		).toThrow();
	});
});
