/**
 * Auth Session Contract Tests
 *
 * Verifies projection at the Better Auth and API response boundaries before
 * auth state reaches local session storage.
 *
 * Key behaviors:
 * - Better Auth Date fields become portable ISO strings
 * - Auth-session responses normalize into identity and bearer sessions
 * - Extra server session metadata is stripped at the identity boundary
 * - Invalid key payloads fail at the auth contract boundary
 */

import { describe, expect, test } from 'bun:test';
import type { EncryptionKeys } from '@epicenter/encryption';
import {
	authIdentityFromAuthSessionResponse,
	authUserFromBetterAuthUser,
	bearerSessionFromAuthSessionResponse,
} from './auth-session.js';

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

describe('authUserFromBetterAuthUser', () => {
	test('projects Better Auth Date fields into the local user', () => {
		const response = betterAuthSessionResponse();

		const user = authUserFromBetterAuthUser(response.user);

		expect(user.createdAt).toBe(response.user.createdAt.toISOString());
		expect(user.updatedAt).toBe(response.user.updatedAt.toISOString());
	});
});

describe('authIdentityFromAuthSessionResponse', () => {
	test('validates the auth-session response as identity only', () => {
		const response = authSessionResponse();

		const identity = authIdentityFromAuthSessionResponse({
			...response,
			session: { token: 'should-not-persist' },
		});

		expect(identity).toEqual({
			user: {
				id: 'user-1',
				name: 'User One',
				email: 'user@example.com',
				emailVerified: true,
				image: null,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-02T00:00:00.000Z',
			},
			encryptionKeys,
		});
	});

	test('returns null for signed-out auth-session response', () => {
		expect(authIdentityFromAuthSessionResponse(null)).toBeNull();
		expect(authIdentityFromAuthSessionResponse(undefined)).toBeNull();
	});
});

describe('bearerSessionFromAuthSessionResponse', () => {
	test('attaches a transport token to the auth-session response', () => {
		const response = authSessionResponse();

		const session = bearerSessionFromAuthSessionResponse(response, {
			token: 'authorization-token',
		});

		expect(session).toEqual({
			token: 'authorization-token',
			user: {
				id: 'user-1',
				name: 'User One',
				email: 'user@example.com',
				emailVerified: true,
				image: null,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-02T00:00:00.000Z',
			},
			encryptionKeys,
		});
	});

	test('throws when auth-session response omits encryption keys', () => {
		expect(() =>
			bearerSessionFromAuthSessionResponse(
				{ user: authSessionResponse().user },
				{ token: 'authorization-token' },
			),
		).toThrow();
	});
});

function authSessionResponse() {
	const response = betterAuthSessionResponse();
	return {
		user: authUserFromBetterAuthUser(response.user),
		encryptionKeys,
	};
}
