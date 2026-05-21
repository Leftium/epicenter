import { oauthProvider } from '@better-auth/oauth-provider';
import type { BetterAuthOptions } from 'better-auth';
import { jwt } from 'better-auth/plugins/jwt';
import { organization } from 'better-auth/plugins/organization';
import { AUTH_OAUTH_SCOPES, TRUSTED_OAUTH_CLIENT_IDS } from './oauth-config';

export function authPlugins({
	resourceAudience,
}: {
	resourceAudience: string;
}) {
	return [
		organization(),
		// ES256 (P-256 ECDSA) signs the id_token and JWT access tokens. The
		// jose default would be EdDSA (Ed25519); pinning ES256 gives the
		// broadest verifier-library support across browser `jose`, Tauri
		// Rust crates, and mobile platforms. The `id_token_signing_alg_values_supported`
		// claim on `/.well-known/openid-configuration` reflects this.
		jwt({ jwks: { keyPairConfig: { alg: 'ES256' } } }),
		oauthProvider({
			loginPage: '/sign-in',
			consentPage: '/consent',
			requirePKCE: true,
			cachedTrustedClients: TRUSTED_OAUTH_CLIENT_IDS,
			validAudiences: [resourceAudience],
			allowDynamicClientRegistration: false,
			scopes: [...AUTH_OAUTH_SCOPES],
			// The plugin warns that /.well-known/oauth-authorization-server/auth must exist
			// because basePath is /auth (not /), so it can't auto-mount at the root.
			// We already mount both discovery endpoints manually in app.ts.
			silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
		}),
	] satisfies NonNullable<BetterAuthOptions['plugins']>;
}
