import type { SchemaClient } from '@better-auth/oauth-provider';
import {
	buildTrustedOAuthClients,
	EPICENTER_OAUTH_SCOPES,
} from '@epicenter/constants/oauth';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema';

let trustedOAuthClientsSeed: Promise<void> | null = null;

/**
 * The shape `projectTrustedOAuthClientToRow` accepts: a flat trusted client
 * with concrete `redirectUris`, as produced by `buildTrustedOAuthClients` for
 * a specific deployment. Exported so tests can declare fixtures without
 * recreating the type.
 */
export type TrustedOAuthClientInput = {
	[K in 'clientId' | 'name']-?: NonNullable<SchemaClient[K]>;
} & {
	type: Extract<
		NonNullable<SchemaClient['type']>,
		'native' | 'user-agent-based'
	>;
	redirectUris: readonly string[];
};

const TRUSTED_OAUTH_CLIENT_POLICY = {
	disabled: false,
	skipConsent: true,
	tokenEndpointAuthMethod: 'none',
	grantTypes: ['authorization_code'],
	responseTypes: ['code'],
	public: true,
	requirePKCE: true,
} satisfies Required<
	Pick<
		SchemaClient,
		| 'disabled'
		| 'skipConsent'
		| 'tokenEndpointAuthMethod'
		| 'grantTypes'
		| 'responseTypes'
		| 'public'
		| 'requirePKCE'
	>
>;

/**
 * Project a checked-in trusted client definition into Better Auth's client row.
 *
 * Use this for seeding and tests that need the exact database representation.
 * It preserves the trusted-client invariant: first-party apps are public PKCE
 * clients, consent is skipped only for the checked-in ids, and every seeded
 * client receives the same API scopes.
 */
export function projectTrustedOAuthClientToRow(
	client: TrustedOAuthClientInput,
	now = new Date(),
) {
	return {
		id: client.clientId,
		clientId: client.clientId,
		disabled: TRUSTED_OAUTH_CLIENT_POLICY.disabled,
		skipConsent: TRUSTED_OAUTH_CLIENT_POLICY.skipConsent,
		scopes: [...EPICENTER_OAUTH_SCOPES],
		createdAt: now,
		updatedAt: now,
		name: client.name,
		redirectUris: [...client.redirectUris],
		tokenEndpointAuthMethod:
			TRUSTED_OAUTH_CLIENT_POLICY.tokenEndpointAuthMethod,
		grantTypes: TRUSTED_OAUTH_CLIENT_POLICY.grantTypes,
		responseTypes: TRUSTED_OAUTH_CLIENT_POLICY.responseTypes,
		public: TRUSTED_OAUTH_CLIENT_POLICY.public,
		type: client.type,
		requirePKCE: TRUSTED_OAUTH_CLIENT_POLICY.requirePKCE,
	} satisfies typeof schema.oauthClient.$inferInsert;
}

/**
 * Upsert the first-party OAuth clients Better Auth is allowed to trust.
 *
 * Call this before handling OAuth requests in a fresh database. The trusted
 * client list is built against `baseURL` so Epicenter Cloud, a self-host,
 * and `wrangler dev` each seed their own callbacks without sharing config.
 *
 * The module-level promise makes concurrent workers share one seed attempt;
 * if the attempt fails, the cache is cleared so a later request can retry
 * instead of pinning a bad startup state. A given worker isolate only ever
 * talks to one deployment, so caching by `baseURL` is unnecessary.
 */
export async function ensureTrustedOAuthClients(
	db: NodePgDatabase<typeof schema>,
	baseURL: string,
) {
	trustedOAuthClientsSeed ??= (async () => {
		for (const client of buildTrustedOAuthClients(baseURL)) {
			const row = projectTrustedOAuthClientToRow(client);
			await db
				.insert(schema.oauthClient)
				.values(row)
				.onConflictDoUpdate({
					target: schema.oauthClient.clientId,
					set: {
						disabled: row.disabled,
						skipConsent: row.skipConsent,
						scopes: row.scopes,
						updatedAt: row.updatedAt,
						name: row.name,
						redirectUris: row.redirectUris,
						tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
						grantTypes: row.grantTypes,
						responseTypes: row.responseTypes,
						public: row.public,
						type: row.type,
						requirePKCE: row.requirePKCE,
					},
				});
		}
	})();
	try {
		await trustedOAuthClientsSeed;
	} catch (error) {
		trustedOAuthClientsSeed = null;
		throw error;
	}
}
