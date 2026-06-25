/**
 * The mirror's write contract: `ingest` is monotonic, so a row only ever moves
 * forward. This is what makes the two writers (`local-books sync` and the
 * recategorize write-back) safe to race on one SQLite file: whoever writes last,
 * the newest object by QuickBooks `LastUpdatedTime` is what survives. A stale
 * write, e.g. recategorize folding its own response back after a concurrent sync
 * already ingested a newer bookkeeper edit, cannot regress the mirror.
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type BooksDb, openBooksDb } from '../src/db.ts';
import { entityDef, type QbObject } from '../src/entities.ts';
import { tempDir } from './helpers.ts';

const PURCHASE = entityDef('Purchase');

/** A Purchase whose one expense line points at `category`, optionally stamped. */
function purchase(category: string, updatedAt?: string): QbObject {
	return {
		Id: 'p1',
		SyncToken: '0',
		...(updatedAt ? { MetaData: { LastUpdatedTime: updatedAt } } : {}),
		Line: [
			{
				Id: '1',
				DetailType: 'AccountBasedExpenseLineDetail',
				AccountBasedExpenseLineDetail: { AccountRef: { value: category } },
			},
		],
	};
}

/** Open a throwaway mirror; the caller closes it. */
function openTmp(): { db: BooksDb; cleanup: () => void } {
	const tmp = tempDir();
	const db = openBooksDb(join(tmp.dir, 'books.db'));
	return { db, cleanup: () => (db.close(), tmp.cleanup()) };
}

/** The stored line category + ordering timestamp for `p1`. */
function stored(db: BooksDb): { category: string; updatedAt: string | null } {
	const row = db.raw
		.query<{ raw: string; updated_at: string | null }, []>(
			`SELECT raw, updated_at FROM purchases WHERE id = 'p1'`,
		)
		.get();
	const obj = JSON.parse(row?.raw ?? '{}');
	return {
		category:
			obj.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef?.value ?? '',
		updatedAt: row?.updated_at ?? null,
	};
}

describe('ingest is monotonic', () => {
	test('a newer object overwrites an older row', () => {
		const { db, cleanup } = openTmp();
		db.ingest(PURCHASE, {
			objects: [purchase('60', '2026-02-01T00:00:00.000Z')],
			syncedAt: 's1',
		});
		db.ingest(PURCHASE, {
			objects: [purchase('77', '2026-02-02T00:00:00.000Z')],
			syncedAt: 's2',
		});
		expect(stored(db).category).toBe('77');
		cleanup();
	});

	test('an older object does NOT regress a newer row (the Sequence B guard)', () => {
		const { db, cleanup } = openTmp();
		// A concurrent sync ingested the newer edit (category 77, T2)...
		db.ingest(PURCHASE, {
			objects: [purchase('77', '2026-02-02T00:00:00.000Z')],
			syncedAt: 's-sync',
		});
		// ...then a stale write-back folds its older response (category 55, T1).
		db.ingest(PURCHASE, {
			objects: [purchase('55', '2026-02-01T00:00:00.000Z')],
			syncedAt: 's-recat',
		});
		// The mirror keeps the newer object; the stale write is dropped.
		expect(stored(db).category).toBe('77');
		expect(stored(db).updatedAt).toBe('2026-02-02T00:00:00.000Z');
		cleanup();
	});

	test('equal timestamps apply, so a re-confirm refreshes the blob', () => {
		const { db, cleanup } = openTmp();
		const t = '2026-02-01T00:00:00.000Z';
		db.ingest(PURCHASE, { objects: [purchase('60', t)], syncedAt: 's1' });
		db.ingest(PURCHASE, { objects: [purchase('77', t)], syncedAt: 's2' });
		expect(stored(db).category).toBe('77');
		cleanup();
	});

	test('missing timestamps fall back to last-writer-wins (the recat fold-back path)', () => {
		const { db, cleanup } = openTmp();
		// Neither object carries MetaData (as a freshly seeded mirror + a mock QB
		// response often do not), so there is nothing to order on: apply the latest.
		db.ingest(PURCHASE, { objects: [purchase('60')], syncedAt: 's1' });
		db.ingest(PURCHASE, { objects: [purchase('77')], syncedAt: 's2' });
		expect(stored(db).category).toBe('77');
		cleanup();
	});

	test('only a passed cursor advances _sync_state', () => {
		const { db, cleanup } = openTmp();
		db.ingest(PURCHASE, { objects: [purchase('60')], syncedAt: 's1' });
		expect(db.readSyncState('Purchase')).toBeNull();

		db.ingest(PURCHASE, {
			objects: [purchase('60')],
			syncedAt: 's2',
			cursor: {
				entity: 'Purchase',
				cdcCursor: '2026-02-01T00:00:00.000Z',
				lastFullPullAt: null,
				lastSyncedAt: '2026-02-01T00:00:00.000Z',
			},
		});
		expect(db.readSyncState('Purchase')?.cdcCursor).toBe(
			'2026-02-01T00:00:00.000Z',
		);
		cleanup();
	});
});
