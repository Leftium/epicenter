/**
 * Schema-affecting config shared between runtime (auth.ts) and CLI (better-auth.config.ts).
 *
 * IMPORTANT: This exports plain data only — no plugin instances. Each adapter
 * must instantiate plugins locally to avoid bun's duplicate @better-auth/core
 * resolution (isolated installs produce different content hashes when optional
 * peers like @cloudflare/workers-types differ across workspace packages).
 */

export const trustedClients = [
	{
		clientId: 'epicenter-desktop',
		name: 'Epicenter Desktop',
		type: 'native',
		redirectUrls: ['tauri://localhost/auth/callback'],
		skipConsent: true,
		metadata: {},
	},
	{
		clientId: 'epicenter-mobile',
		name: 'Epicenter Mobile',
		type: 'native',
		redirectUrls: ['epicenter://auth/callback'],
		skipConsent: true,
		metadata: {},
	},
] as const;

/** Plain config — no plugin instances, no @better-auth/core types crossing boundaries. */
export const baseAuthConfig = {
	basePath: '/auth',
	emailAndPassword: { enabled: true },
} as const;
