import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exchangeAuthorizationCode, refreshAccessToken } from '../src/oauth.ts';
import type { TokenSet } from '../src/tokens.ts';
import { makeConfig } from './helpers.ts';
import { type MockQbServer, startMockQbServer } from './mock-qb-server.ts';

let server: MockQbServer;
const NOW = Date.parse('2026-06-21T12:00:00.000Z');

beforeAll(() => {
	server = startMockQbServer();
});
afterAll(() => server.stop());

test('authorization-code exchange yields a token set', async () => {
	const config = makeConfig({ tokenUrl: server.tokenUrl, realmOverride: server.realmId });
	const { data, error } = await exchangeAuthorizationCode(
		config,
		{ code: 'auth-code', realmId: server.realmId },
		{ now: () => NOW },
	);
	expect(error).toBeNull();
	expect(data?.realmId).toBe(server.realmId);
	expect(data?.accessToken).toStartWith('access-');
	expect(Date.parse(data!.accessTokenExpiresAt)).toBe(NOW + 3600 * 1000);
	expect(server.hits.token).toBeGreaterThanOrEqual(1);
});

test('refresh exchange mints a new token set', async () => {
	const config = makeConfig({ tokenUrl: server.tokenUrl, realmOverride: server.realmId });
	const before = server.hits.token;
	const token: TokenSet = {
		realmId: server.realmId,
		environment: 'sandbox',
		accessToken: 'old-access',
		refreshToken: 'old-refresh',
		accessTokenExpiresAt: new Date(NOW).toISOString(),
		refreshTokenExpiresAt: new Date(NOW + 8726400 * 1000).toISOString(),
		obtainedAt: new Date(NOW).toISOString(),
	};
	const { data, error } = await refreshAccessToken(config, token, { now: () => NOW });
	expect(error).toBeNull();
	expect(data?.accessToken).not.toBe('old-access');
	expect(server.hits.token).toBe(before + 1);
});

test('a missing client secret is reported, not thrown', async () => {
	const config = makeConfig({ tokenUrl: server.tokenUrl, clientSecret: null });
	const { error } = await exchangeAuthorizationCode(
		config,
		{ code: 'x', realmId: server.realmId },
		{ now: () => NOW },
	);
	expect(error?.name).toBe('MissingCredentials');
});
