/**
 * `recategorizeExpense` driven against a mock QuickBooks server and a seeded
 * mirror: the write-through path end to end (read the SyncToken from the mirror
 * -> sparse-update QuickBooks -> fold the authoritative response back), and the
 * safety primitive (a stale SyncToken is rejected, never clobbered). The CLI
 * `recategorize` verb is a thin adapter over this.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeConfig } from '../../test/helpers.ts';
import { makePurchase, startMockQbServer } from '../../test/mock-qb-server.ts';
import { openBooksDb } from '../db.ts';
import { entityDef } from '../entities.ts';
import { createFileTokenStore } from '../token-store.ts';
import type { TokenSet } from '../tokens.ts';
import { createQbAccess } from './qb-access.ts';
import { recategorizeExpense } from './recategorize.ts';

const NOW = Date.parse('2026-02-01T00:00:00.000Z');
const now = () => NOW;

/** Boot a mock company with one Purchase, seed its token + mirror, return deps. */
async function setup(
	opts: { mockSyncToken?: string; mirrorSyncToken?: string } = {},
) {
	const dir = mkdtempSync(join(tmpdir(), 'local-books-'));
	const mock = startMockQbServer({ now });
	mock.put(
		'Purchase',
		makePurchase('p1', { SyncToken: opts.mockSyncToken ?? '0' }),
	);

	const tokenFile = join(dir, 'credentials.json');
	const config = makeConfig({
		dataDir: dir,
		apiBase: mock.apiBase,
		tokenUrl: mock.tokenUrl,
		credentialsPath: tokenFile,
		entities: ['Purchase'],
	});
	const store = createFileTokenStore(tokenFile);
	const token: TokenSet = {
		realmId: mock.realmId,
		environment: 'sandbox',
		accessToken: 'access-seed',
		refreshToken: 'refresh-seed',
		accessTokenExpiresAt: new Date(NOW + 86_400_000).toISOString(),
		refreshTokenExpiresAt: new Date(NOW + 8_726_400_000).toISOString(),
		obtainedAt: new Date(NOW).toISOString(),
	};
	await store.set(token);

	const path = join(dir, mock.realmId, 'books.db');
	const db = openBooksDb(path);
	db.ingest(
		[
			{
				def: entityDef('Purchase'),
				objects: [
					makePurchase('p1', { SyncToken: opts.mirrorSyncToken ?? '0' }),
				],
			},
		],
		{ syncedAt: '2026-01-20T00:00:00.000Z' },
	);
	db.close();

	const openQb = createQbAccess({ config, realmId: mock.realmId, store, now });
	return {
		mock,
		path,
		openQb,
		cleanup: () => {
			mock.stop();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function lineAccount(obj: Record<string, unknown>): string | undefined {
	const line = (obj.Line as Record<string, unknown>[] | undefined)?.[0];
	const detail = line?.AccountBasedExpenseLineDetail as
		| { AccountRef?: { value?: string } }
		| undefined;
	return detail?.AccountRef?.value;
}

describe('recategorizeExpense', () => {
	test('moves the expense line in QuickBooks and folds it into the mirror', async () => {
		const { mock, path, openQb, cleanup } = await setup();

		const { data, error } = await recategorizeExpense({
			openQb,
			dbPath: path,
			input: {
				entity: 'Purchase',
				id: 'p1',
				account_id: '77',
				account_name: 'Cloud Infrastructure',
			},
		});
		expect(error).toBeNull();
		expect(data?.changed[0]?.toAccount).toBe('Cloud Infrastructure');
		expect(mock.hits.update).toBe(1);

		// QuickBooks (the source of truth) now has the new category + a bumped token.
		const remote = mock.get('Purchase', 'p1');
		expect(remote && lineAccount(remote)).toBe('77');
		expect(remote?.SyncToken).toBe('1');

		// The mirror reflects the authoritative response (token '1', not the old '0').
		const db = openBooksDb(path);
		const row = db.raw
			.query<{ raw: string }, []>(`SELECT raw FROM purchases WHERE id = 'p1'`)
			.get();
		const mirrored = JSON.parse(row?.raw ?? '{}');
		expect(lineAccount(mirrored)).toBe('77');
		expect(mirrored.SyncToken).toBe('1');
		db.close();

		cleanup();
	});

	test('a stale SyncToken is rejected, leaving QuickBooks untouched', async () => {
		// Mirror thinks the token is '0'; QuickBooks has moved on to '5'.
		const { mock, path, openQb, cleanup } = await setup({
			mockSyncToken: '5',
			mirrorSyncToken: '0',
		});

		const { error } = await recategorizeExpense({
			openQb,
			dbPath: path,
			input: { entity: 'Purchase', id: 'p1', account_id: '77' },
		});
		expect(error).not.toBeNull();

		// QuickBooks kept the original category: no clobber on a stale write.
		const remote = mock.get('Purchase', 'p1');
		expect(remote && lineAccount(remote)).toBe('60');
		expect(remote?.SyncToken).toBe('5');
		cleanup();
	});

	test('errors clearly when the transaction is not in the mirror', async () => {
		const { path, openQb, cleanup } = await setup();
		const { error } = await recategorizeExpense({
			openQb,
			dbPath: path,
			input: { entity: 'Purchase', id: 'does-not-exist', account_id: '77' },
		});
		expect(error?.message).toContain('mirror');
		cleanup();
	});
});
