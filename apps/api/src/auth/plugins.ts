import { oauthProvider } from '@better-auth/oauth-provider';
import {
	buildTrustedOAuthClients,
	EPICENTER_OAUTH_SCOPES,
} from '@epicenter/constants/oauth';
import type { BetterAuthOptions } from 'better-auth';
import { jwt } from 'better-auth/plugins/jwt';

/**
 * Build the Better Auth plugins that define Epicenter's OAuth server boundary.
 *
 * Use this only from the API auth factory, where the request URL is known. The
 * `resourceAudience` must be the API base URL that clients pass as OAuth
 * `resource`; keeping those values equal is what prevents access tokens minted
 * for one resource server from being replayed against another. The same base
 * URL feeds `buildTrustedOAuthClients`, so the trusted-client-id set matches
 * the clients the seeder will install for this deployment.
 */
export function authPlugins(resourceAudience: string) {
	const trustedOAuthClientIds = new Set(
		buildTrustedOAuthClients(resourceAudience).map((client) => client.clientId),
	);
	return [
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
			cachedTrustedClients: trustedOAuthClientIds,
			validAudiences: [resourceAudience],
			allowDynamicClientRegistration: false,
			scopes: [...EPICENTER_OAUTH_SCOPES],
			// The plugin warns that /.well-known/oauth-authorization-server/auth must exist
			// because basePath is /auth (not /), so it can't auto-mount at the root.
			// We already mount both discovery endpoints manually in app.ts.
			silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
		}),
	] satisfies NonNullable<BetterAuthOptions['plugins']>;
}
