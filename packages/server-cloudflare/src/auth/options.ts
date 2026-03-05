import { oauthProvider } from '@better-auth/oauth-provider';
import type { BetterAuthOptions } from 'better-auth';
import { bearer } from 'better-auth/plugins/bearer';
import { jwt } from 'better-auth/plugins/jwt';

/**
 * Schema-affecting auth options shared between the runtime worker and the CLI.
 *
 * **Runtime** — `src/auth/server.ts` spreads these into `createAuth()`, which
 * adds Cloudflare-specific runtime config (KV secondary storage, cookie cache,
 * trusted origins, etc.).
 *
 * **CLI** — `better-auth.config.ts` (package root) spreads these into a
 * standalone `betterAuth()` call so `bun run auth:generate` and
 * `bun run auth:migrate` produce migrations that match the runtime schema.
 *
 * Every option that influences the database schema belongs here. Runtime-only
 * options (secondaryStorage, trustedOrigins, cookies, etc.) belong in
 * `createAuth()` — they don't affect the schema.
 */
export const authOptions = {
	basePath: '/auth',
	emailAndPassword: { enabled: true },
	plugins: [
		bearer(),
		jwt(),
		oauthProvider({
			loginPage: '/sign-in',
			consentPage: '/consent',
			requirePKCE: true,
			allowDynamicClientRegistration: true,
			trustedClients: [
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
			],
		}),
	],
} satisfies Partial<BetterAuthOptions>;
