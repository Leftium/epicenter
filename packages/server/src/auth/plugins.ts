import { oauthProvider } from '@better-auth/oauth-provider';
import { JWT_SIGNING_ALG } from '@epicenter/constants/auth';
import {
	buildTrustedOAuthClients,
	EPICENTER_OAUTH_SCOPES,
} from '@epicenter/constants/oauth';
import type { BetterAuthOptions } from 'better-auth';
import { jwt } from 'better-auth/plugins/jwt';

/**
 * Build the Better Auth plugins that define Epicenter's OAuth server boundary.
 *
 * Use this only from the API auth factory, where the request URL is known.
 * `apiBaseURL` plays two roles: it's the OAuth resource audience (clients
 * pass it as `resource`, and we accept tokens minted only for this audience,
 * preventing tokens from one resource server being replayed against another),
 * and it's the deployment input to `buildTrustedOAuthClients` so the
 * trusted-client-id set matches the clients the seeder will install.
 */
export function authPlugins(apiBaseURL: string) {
	const trustedOAuthClientIds = new Set(
		buildTrustedOAuthClients(apiBaseURL).map((client) => client.clientId),
	);
	return [
		// `JWT_SIGNING_ALG` (ES256, P-256 ECDSA) signs the id_token and JWT
		// access tokens. `id_token_signing_alg_values_supported` on
		// `/.well-known/openid-configuration` is derived from this same
		// `keyPairConfig.alg` by the OAuth provider plugin, not a second
		// hardcoded list, so the advertised alg and the signing alg cannot
		// drift. See that constant for why ES256 is pinned over the `jose`
		// EdDSA default, and why `alg` is the only thing we configure (Better
		// Auth derives the key shape from it).
		//
		// `keyPairConfig.alg` governs only newly minted keys. If the `jwks`
		// table ever holds a row of another algorithm (such as a pre-ES256
		// Ed25519 key), signing crashes because `importJWK` rejects the
		// mismatch. The fix is to delete that stale row so Better Auth mints a
		// compliant key, not to filter the table in this read path.
		jwt({ jwks: { keyPairConfig: { alg: JWT_SIGNING_ALG } } }),
		oauthProvider({
			loginPage: '/sign-in',
			consentPage: '/consent',
			requirePKCE: true,
			cachedTrustedClients: trustedOAuthClientIds,
			validAudiences: [apiBaseURL],
			allowDynamicClientRegistration: false,
			scopes: [...EPICENTER_OAUTH_SCOPES],
			// The plugin warns that /.well-known/oauth-authorization-server/auth must exist
			// because basePath is /auth (not /), so it can't auto-mount at the root.
			// We already mount both discovery endpoints manually in app.ts.
			silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
		}),
	] satisfies NonNullable<BetterAuthOptions['plugins']>;
}
