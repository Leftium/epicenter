import { describe, expect, test } from 'bun:test';
import type { AuthServerClient } from './auth-server-client.ts';
import { createCliAuth } from './cli-auth.ts';
import { createCredentialStore } from './credential-store.ts';
import type { Session } from '../contracts/session.ts';

const session: Session = {
	user: {
		id: 'user-1',
		name: 'User One',
		email: 'user@example.com',
		emailVerified: true,
		image: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	},
	session: {
		id: 'session-1',
		token: 'session-token',
		userId: 'user-1',
		expiresAt: '2026-02-01T00:00:00.000Z',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		ipAddress: null,
		userAgent: null,
	},
	encryptionKeys: [
		{
			version: 1,
			userKeyBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
		},
	],
};

function store() {
	return createCredentialStore({
		path: `/tmp/epicenter-cli-auth-${crypto.randomUUID()}.json`,
		storageMode: 'file',
		clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
	});
}

describe('createCliAuth', () => {
	test('stores set-auth-token as bearerToken without mutating session token', async () => {
		const credentialStore = store();
		const client: AuthServerClient = {
			serverOrigin: 'https://api.epicenter.so',
			async requestDeviceCode() {
				return {
					device_code: 'device-code',
					user_code: 'USER-CODE',
					verification_uri: 'https://api.epicenter.so/device',
					verification_uri_complete: 'https://api.epicenter.so/device?code=USER',
					expires_in: 600,
					interval: 0,
				};
			},
			async pollDeviceToken() {
				return { access_token: 'device-token', expires_in: 3600 };
			},
			async getSession() {
				return { session, setAuthToken: 'rotated-bearer-token' };
			},
			async signOut() {},
		};

		await createCliAuth(
			{ authServerClient: client, credentialStore, sleep: async () => {} },
			{ clientId: 'epicenter-cli' },
		).loginWithDeviceCode();

		const credential = await credentialStore.get('https://api.epicenter.so');
		expect(credential?.bearerToken).toBe('rotated-bearer-token');
		expect(credential?.session.session.token).toBe('session-token');
	});

	test('surfaces terminal device polling errors', async () => {
		const client: AuthServerClient = {
			serverOrigin: 'https://api.epicenter.so',
			async requestDeviceCode() {
				return {
					device_code: 'device-code',
					user_code: 'USER-CODE',
					verification_uri: 'https://api.epicenter.so/device',
					verification_uri_complete: 'https://api.epicenter.so/device?code=USER',
					expires_in: 600,
					interval: 0,
				};
			},
			async pollDeviceToken() {
				return { error: 'access_denied' };
			},
			async getSession() {
				return { session, setAuthToken: null };
			},
			async signOut() {},
		};

		await expect(
			createCliAuth(
				{
					authServerClient: client,
					credentialStore: store(),
					sleep: async () => {},
				},
				{ clientId: 'epicenter-cli' },
			).loginWithDeviceCode(),
		).rejects.toThrow('Authorization denied');
	});
});
