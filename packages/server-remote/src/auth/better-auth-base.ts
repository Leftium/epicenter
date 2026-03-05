import { oauthProvider } from '@better-auth/oauth-provider';
import type { BetterAuthOptions } from 'better-auth';
import { bearer } from 'better-auth/plugins/bearer';
import { jwt } from 'better-auth/plugins/jwt';

/** Schema-affecting config shared between runtime (auth.ts) and CLI (better-auth.config.ts). */
export const baseAuthConfig = {
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
} as const satisfies Partial<BetterAuthOptions>;
