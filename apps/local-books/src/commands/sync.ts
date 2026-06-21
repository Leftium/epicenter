import type { ParsedArgs } from '../args.ts';
import { resolveRealm } from '../companies.ts';
import { loadConfig } from '../config.ts';
import { openBooksDb } from '../db.ts';
import { isKnownEntity, DEFAULT_ENTITIES } from '../entities.ts';
import { createKeyring } from '../keyring.ts';
import type { OAuthDeps } from '../oauth.ts';
import { dbPath } from '../paths.ts';
import { createQbClient } from '../qb-client.ts';
import { type SyncDeps, syncAll } from '../sync.ts';
import { createTokenManager, loadToken } from '../token-manager.ts';

/**
 * Refresh the local mirror. Mode (FULL vs INCREMENTAL) is chosen per entity from
 * stored `_sync_state`; `--full` forces FULL; `--entity` narrows the set.
 */
export async function runSync(args: ParsedArgs): Promise<number> {
	const config = loadConfig({
		dataDir: args.dataDir,
		environment: args.environment,
		realm: args.realm,
	});

	const realm = resolveRealm(config);
	if (realm.error !== null) {
		console.error(realm.error);
		return 1;
	}
	const realmId = realm.realmId;

	const entities = args.entities.length > 0 ? args.entities : config.entities;
	const unknown = entities.filter((name) => !isKnownEntity(name));
	if (unknown.length > 0) {
		console.error(
			`Unknown entities: ${unknown.join(', ')}. Known: ${DEFAULT_ENTITIES.join(', ')}.`,
		);
		return 1;
	}

	const keyring = createKeyring(config);
	const token = await loadToken(keyring, realmId);
	if (!token) {
		console.error(`No stored token for company ${realmId}. Run "local-books auth".`);
		return 1;
	}

	const now = () => Date.now();
	const oauthDeps: OAuthDeps = { now, log: (m) => console.error(m) };
	const tokens = createTokenManager({ config, keyring, token, deps: oauthDeps });
	const client = createQbClient({
		config,
		realmId,
		tokens,
		log: (m) => console.error(m),
	});
	const db = openBooksDb(dbPath(config.dataDir, realmId), realmId);
	const deps: SyncDeps = { db, client, config, now, log: (m) => console.error(m) };

	console.error(
		`Syncing ${entities.join(', ')} for company ${realmId} (${config.environment})${args.full ? ' [--full]' : ''}...`,
	);
	const { results, failures } = await syncAll(deps, { forceFull: args.full, entities });
	db.close();

	for (const r of results) {
		console.log(
			`${r.entity.padEnd(12)} ${r.mode.padEnd(11)} ${r.upserted} upserted, ${r.deleted} deleted` +
				`  cursor ${r.cursorBefore ?? '(none)'} -> ${r.cursorAfter}`,
		);
	}
	for (const f of failures) {
		console.error(`${f.entity}: FAILED — ${f.error.message}`);
	}

	return failures.length > 0 ? 1 : 0;
}
