import {
	EPICENTER_OAUTH_SCOPES,
	EPICENTER_TRUSTED_OAUTH_CLIENTS,
} from '@epicenter/constants/oauth';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema';

let trustedOAuthClientsSeed: Promise<void> | null = null;

type TrustedOAuthClientInput = {
	clientId: string;
	name: string;
	runtime: (typeof EPICENTER_TRUSTED_OAUTH_CLIENTS)[number]['runtime'];
	redirectUris: readonly string[];
};

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
		type: client.runtime === 'native' ? 'native' : 'user-agent-based',
		requirePKCE: true,
	} satisfies typeof schema.oauthClient.$inferInsert;
}

/**
 * Upsert the first-party OAuth clients Better Auth is allowed to trust.
 *
 * Call this before handling OAuth requests in a fresh database. The module-level
 * promise makes concurrent workers share one seed attempt; if the attempt fails,
 * the cache is cleared so a later request can retry instead of pinning a bad
 * startup state.
 */
export async function ensureTrustedOAuthClients(
	db: NodePgDatabase<typeof schema>,
) {
	trustedOAuthClientsSeed ??= (async () => {
		for (const client of EPICENTER_TRUSTED_OAUTH_CLIENTS) {
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
