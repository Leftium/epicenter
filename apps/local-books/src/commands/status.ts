import { existsSync } from 'node:fs';
import type { ParsedArgs } from '../cli.ts';
import { openBooksDb } from '../db.ts';
import { entityDef } from '../entities.ts';
import { dbPath } from '../paths.ts';
import { loadToken } from '../token-manager.ts';
import { isAccessTokenExpired, isRefreshTokenExpired } from '../tokens.ts';
import { formatRelative, resolveCompany } from './context.ts';

/** Report token state and the per-entity mirror state (cursor, counts). */
export async function runStatus(args: ParsedArgs): Promise<number> {
	const { data: company, error } = resolveCompany(args);
	if (error !== null) {
		console.error(error);
		return 1;
	}
	const { config, realmId, keyring } = company;

	const token = await loadToken(keyring, realmId);
	const now = Date.now();

	console.log(`Company:      ${realmId}`);
	console.log(`Environment:  ${config.environment}`);
	console.log(`Data dir:     ${config.dataDir}`);
	console.log(`Token file:   ${config.credentialsPath}`);

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

	const db = openBooksDb(path);
	// The cursor is one high-water mark for the whole company (CDC's contract), so
	// it is shown once at the realm level, not repeated per entity.
	const realm = db.readRealmState();
	console.log(`Schema:       v${db.getMeta('schema_version')}`);
	console.log(`Cursor:       ${realm.cdcCursor ?? '-'}`);
	console.log(`Last full:    ${realm.lastFullPullAt ?? '-'}`);
	console.log(`Last synced:  ${realm.lastSyncedAt ?? '-'}`);
	console.log('');
	console.log(
		`${'Entity'.padEnd(12)} ${'Rows'.padStart(7)} ${'Deleted'.padStart(8)}`,
	);
	for (const name of config.entities) {
		const s = db.entityStatus(entityDef(name));
		// Only the uninitialized case is worth a marker: a row count already tells
		// the reader a pulled entity's state, but `0` alone is ambiguous between
		// "pulled, genuinely empty" and "never pulled". Annotate the latter (the
		// only informative state) instead of printing a status on all 16 lines.
		if (!s.initialized) {
			console.log(`${name.padEnd(12)} ${'—'.padStart(7)} — not pulled (run sync)`);
			continue;
		}
		console.log(
			`${name.padEnd(12)} ${String(s.rows).padStart(7)} ${String(s.deleted).padStart(8)}`,
		);
	}
	db.close();
	return 0;
}
