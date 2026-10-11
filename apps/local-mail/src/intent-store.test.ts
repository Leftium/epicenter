/**
 * Assertion revisions protect newer choices from stale Gmail responses.
 * Exercises overlapping database batches, allocation across store instances,
 * and retirement or explicit discard followed by a new assertion over the
 * same durable database. No mailbox cache is opened.
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { createTestAppSqlite } from './app-sqlite.test-support.js';
import { openIntentStore } from './intent-store.js';
import { LOCAL_SCHEMA } from './storage.js';

const AT = '2026-09-09T00:00:00.000Z';
const SUB = 'account-one';

async function setup() {
	const database = createTestAppSqlite();
	for (const statement of LOCAL_SCHEMA) expectOk(await database.run(statement));
	return { database, intents: openIntentStore(database, SUB) };
}

test('an older delivery cannot retire an overlapping undo from another store', async () => {
	const { database: real } = await setup();
	const release = Promise.withResolvers<void>();
	let batches = 0;
	const database = {
		...real,
		async batch(statements: Parameters<typeof real.batch>[0]) {
			if (++batches === 2) await release.promise;
			return real.batch(statements);
		},
	};
	const firstStore = openIntentStore(database, SUB);
	const secondStore = openIntentStore(database, SUB);
	try {
		const first = firstStore.assert(
			[{ messageId: 'm1', labelId: 'TRASH', want: true }],
			AT,
		);
		const undo = secondStore.assert(
			[{ messageId: 'm1', labelId: 'TRASH', want: false }],
			AT,
		);
		await first;
		const snapshot = await firstStore.pending();
		release.resolve();
		await undo;
		expect(await firstStore.retire(snapshot)).toBe(0);
		const pending = await secondStore.pending();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.want).toBe(false);
		expect(pending[0]?.revision).toBeGreaterThan(snapshot[0]!.revision);
		expect(await secondStore.retire(pending)).toBe(1);
		expect(await secondStore.pending()).toEqual([]);
	} finally {
		release.resolve();
		real.close();
	}
});

test('a new store never reuses a retired revision when the outbox is empty', async () => {
	const { database, intents } = await setup();
	try {
		const assertion = { messageId: 'm1', labelId: 'TRASH', want: true };
		await intents.assert([assertion], AT);
		const snapshot = await intents.pending();
		await intents.retire(snapshot);
		const reopened = openIntentStore(database, SUB);
		await reopened.assert([assertion], AT);
		expect(await reopened.retire(snapshot)).toBe(0);
		expect((await reopened.pending())[0]?.revision).toBeGreaterThan(
			snapshot[0]!.revision,
		);
	} finally {
		database.close();
	}
});

test('overlapping batches allocate distinct ordered revisions for every assertion', async () => {
	const { database, intents } = await setup();
	try {
		await Promise.all(
			['a', 'b'].map((messageId) =>
				intents.assert(
					['INBOX', 'TRASH'].map((labelId) => ({
						messageId,
						labelId,
						want: true,
					})),
					AT,
				),
			),
		);
		expect((await intents.pending()).map((intent) => intent.revision)).toEqual([
			1, 2, 3, 4,
		]);
	} finally {
		database.close();
	}
});

test('the revision stays monotonic after every assertion is discarded', async () => {
	const { database, intents } = await setup();
	try {
		await intents.assert(
			[{ messageId: 'm1', labelId: 'INBOX', want: false }],
			AT,
		);
		const first = (await intents.pending())[0]!.revision;
		await intents.discardAll();
		await intents.assert(
			[{ messageId: 'm2', labelId: 'INBOX', want: false }],
			AT,
		);
		expect((await intents.pending())[0]?.revision).toBeGreaterThan(first);
	} finally {
		database.close();
	}
});
