/**
 * Lazily open a write-capable QuickBooks client for a realm. The `report` and
 * `recategorize` verbs (the live-QuickBooks capabilities) hold this thunk rather
 * than credentials: it reloads the token from the store on each call, so it
 * always starts from the newest persisted (possibly rotated) credentials.
 *
 * It is its own seam so the live capabilities never reach into the token store
 * directly, and so a future daemon (ADR-0072) can hand the same opener to the
 * action wrappers it builds over these cores.
 */

import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AppConfig } from '../config.ts';
import { createQbClient, type QbClient } from '../qb-client.ts';
import { createTokenManager } from '../token-manager.ts';
import type { TokenStore } from '../token-store.ts';

/** Opens a QB client for the realm, or a user-facing reason it cannot. */
export type OpenQbClient = () => Promise<Result<QbClient, string>>;

export function createQbAccess({
	config,
	realmId,
	store,
	now,
}: {
	config: AppConfig;
	realmId: string;
	store: TokenStore;
	now: () => number;
}): OpenQbClient {
	return async () => {
		const token = await store.get(realmId);
		if (!token) {
			return Err(
				`No stored credentials for company ${realmId}. Run "local-books auth".`,
			);
		}
		const tokens = createTokenManager({ config, store, token, now });
		return Ok(createQbClient({ config, realmId, tokens }));
	};
}
