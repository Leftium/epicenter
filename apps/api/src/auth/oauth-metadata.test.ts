import { expect, test } from 'bun:test';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { Hono } from 'hono';
import {
	createOAuthIssuerURL,
	createOAuthJwksURL,
	OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
	OAUTH_METADATA_CACHE_CONTROL,
	OAUTH_OPENID_CONFIGURATION_PATH,
	OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
} from './oauth-metadata.js';

test('OAuth metadata paths follow Better Auth issuer-path layout', () => {
	expect(createOAuthIssuerURL('https://api.epicenter.so')).toBe(
		'https://api.epicenter.so/auth',
	);
	expect(createOAuthJwksURL('https://api.epicenter.so')).toBe(
		'https://api.epicenter.so/auth/jwks',
	);
	expect(OAUTH_OPENID_CONFIGURATION_PATH).toBe(
		'/auth/.well-known/openid-configuration',
	);
	expect(OAUTH_AUTHORIZATION_SERVER_METADATA_PATH).toBe(
		'/.well-known/oauth-authorization-server/auth',
	);
	expect(OAUTH_PROTECTED_RESOURCE_METADATA_PATH).toBe(
		'/.well-known/oauth-protected-resource',
	);
});

test('issuer-path discovery route is registered before the auth catch-all', async () => {
	const app = new Hono();
	app.get(OAUTH_OPENID_CONFIGURATION_PATH, (c) => c.text('openid'));
	app.on(['GET', 'POST'], '/auth/*', (c) => c.text('auth'));

	const response = await app.request(
		`https://api.epicenter.so${OAUTH_OPENID_CONFIGURATION_PATH}`,
	);

	expect(await response.text()).toBe('openid');
});

test('protected resource metadata advertises API resource and auth issuer', async () => {
	const resource = oauthProviderResourceClient();
	const metadata =
		await resource.getActions().getProtectedResourceMetadata({
			resource: 'https://api.epicenter.so',
			authorization_servers: ['https://api.epicenter.so/auth'],
		});

	expect(metadata.resource).toBe('https://api.epicenter.so');
	expect(metadata.authorization_servers).toEqual([
		'https://api.epicenter.so/auth',
	]);
	expect(OAUTH_METADATA_CACHE_CONTROL).toContain('max-age=15');
});
