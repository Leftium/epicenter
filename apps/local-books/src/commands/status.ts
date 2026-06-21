import { existsSync } from 'node:fs';
import type { ParsedArgs } from '../args.ts';
import { resolveRealm } from '../companies.ts';
import { loadConfig } from '../config.ts';
import { openBooksDb } from '../db.ts';
import { entityDef } from '../entities.ts';
import { createKeyring } from '../keyring.ts';
import { dbPath } from '../paths.ts';
import { loadToken } from '../token-manager.ts';
import {
	formatRelative,
	isAccessTokenExpired,
	isRefreshTokenExpired,
} from '../tokens.ts';

/** Report token state and the per-entity mirror state (cursor, counts). */
export async function runStatus(args: ParsedArgs): Promise<number> {
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

	const keyring = createKeyring(config);
	const token = await loadToken(keyring, realmId);
	const now = Date.now();

	console.log(`Company:      ${realmId}`);
	console.log(`Environment:  ${config.environment}`);
	console.log(`Data dir:     ${config.dataDir}`);
	console.log(`Keyring:      ${keyring.backend}`);

	if (!token) {
		console.log(`Token:        none — run "local-books auth"`);
	} else {
		const access = isAccessTokenExpired(token, now, 0) ? 'EXPIRED' : 'valid';
		const refresh = isRefreshTokenExpired(token, now) ? 'EXPIRED' : 'valid';
		console.log(
			`Token:        access ${access} (${formatRelative(token.accessTokenExpiresAt, now)}), ` +
				`refresh ${refresh} (${formatRelative(token.refreshTokenExpiresAt, now)})`,
		);
	}

	const path = dbPath(config.dataDir, realmId);
	if (!existsSync(path)) {
		console.log(
			`Mirror:       not created yet — run "local-books sync --full"`,
		);
		return 0;
	}

	const db = openBooksDb(path, realmId);
	console.log(`Schema:       v${db.getMeta('schema_version')}`);
	console.log('');
	console.log(
		`${'Entity'.padEnd(12)} ${'Rows'.padStart(7)} ${'Deleted'.padStart(8)}  ${'Cursor (changedSince)'.padEnd(26)} Last full pull`,
	);
	for (const name of config.entities) {
		const s = db.entityStatus(entityDef(name));
		console.log(
			`${name.padEnd(12)} ${String(s.rows).padStart(7)} ${String(s.deleted).padStart(8)}  ` +
				`${(s.cdcCursor ?? '-').padEnd(26)} ${s.lastFullPullAt ?? '-'}`,
		);
	}
	db.close();
	return 0;
}
