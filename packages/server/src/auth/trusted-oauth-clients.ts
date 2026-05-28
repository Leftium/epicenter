import {
	EPICENTER_OAUTH_SCOPES,
	type TrustedOAuthClient,
} from '@epicenter/constants/oauth';
import type * as schema from '../db/schema';

/**
 * Project a checked-in trusted client definition into Better Auth's client row.
 *
 * Use this for seeding and tests that need the exact database representation.
 * It preserves the trusted-client invariant: first-party apps are public PKCE
 * clients with PKCE required, consent skipped, the authorization-code grant,
 * and the common Epicenter scopes.
 *
 * This is pure (it only imports the schema as a type), so it carries no `pg` or
 * `drizzle` runtime dependency. The deploy-time seeding it feeds lives in the
 * `apps/api` `oauth:seed:*` script, which owns the Postgres connection and the
 * upsert; keeping that out of this package keeps `pg`/`node-postgres` and the
 * extra `drizzle` graph out of the worker's module and type programs.
 */
export function projectTrustedOAuthClientToRow(
	client: TrustedOAuthClient,
	now = new Date(),
) {
	return {
		id: client.clientId,
		clientId: client.clientId,
		disabled: false,
		skipConsent: true,
		scopes: [...EPICENTER_OAUTH_SCOPES],
		createdAt: now,
		updatedAt: now,
		name: client.name,
		redirectUris: [...client.redirectUris],
		tokenEndpointAuthMethod: 'none',
		grantTypes: ['authorization_code'],
		responseTypes: ['code'],
		public: true,
		type: client.type,
		requirePKCE: true,
	} satisfies typeof schema.oauthClient.$inferInsert;
}
