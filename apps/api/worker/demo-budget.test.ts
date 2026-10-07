/**
 * The demo budget over real SQLite. `bun:sqlite` stands in for the Durable
 * Object's SQLite storage: the same SQL runs, `transactionSync` is a real
 * transaction, and reopening the database file is what an evicted object sees
 * when it wakes.
 */

import { Database } from 'bun:sqlite';
import { afterEach, expect, mock, setSystemTime, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Durable Object base class only matters at the Workers runtime.
mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));

const { DEMO_BUDGET, DemoGenerationBudget } = await import('./demo-budget.js');

function sqliteStorage(db: Database) {
	return {
		sql: {
			exec: (query: string, ...bindings: (string | number)[]) =>
				db.query(query).all(...bindings) as Record<string, string | number>[],
		},
		transactionSync: <T>(closure: () => T) => db.transaction(closure)(),
	};
}

function newBudget(storage: ReturnType<typeof sqliteStorage>) {
	return new DemoGenerationBudget(
		{ storage } as unknown as DurableObjectState,
		{} as Cloudflare.Env,
	);
}

function consumeAt(budget: ReturnType<typeof newBudget>, now: number) {
	setSystemTime(new Date(now));
	return budget.consume();
}

const MINUTE = 60_000;
const DAY = 86_400_000;
// 2026-10-07T00:00:00Z: a UTC midnight, so day arithmetic is easy to read.
const MIDNIGHT = Date.UTC(2026, 9, 7);

afterEach(() => setSystemTime());

test('admits ten attempts per minute and denies until the next minute without counting denials', () => {
	const ledger = newBudget(sqliteStorage(new Database(':memory:')));
	const start = MIDNIGHT + 5 * MINUTE + 15_000;

	for (let i = 0; i < DEMO_BUDGET.perMinute; i++) {
		expect(consumeAt(ledger, start + i)).toEqual({ allowed: true });
	}
	for (let i = 0; i < 5; i++) {
		expect(consumeAt(ledger, start + 1000)).toEqual({
			allowed: false,
			retryAfterSeconds: 44,
		});
	}

	// The next clock minute is a fresh window. Denials spent nothing from the
	// day, so exactly 90 more are left today.
	let admitted = 0;
	for (let minute = 1; minute <= 20; minute++) {
		for (let i = 0; i < DEMO_BUDGET.perMinute; i++) {
			if (consumeAt(ledger, start + minute * MINUTE).allowed) admitted++;
		}
	}
	expect(admitted).toBe(DEMO_BUDGET.perDay - DEMO_BUDGET.perMinute);
});

test('the daily cap holds until UTC midnight, then a new day admits again', () => {
	const ledger = newBudget(sqliteStorage(new Database(':memory:')));
	for (let minute = 0; minute < 10; minute++) {
		for (let i = 0; i < DEMO_BUDGET.perMinute; i++) {
			expect(consumeAt(ledger, MIDNIGHT + minute * MINUTE).allowed).toBe(true);
		}
	}

	// A fresh minute late in the day is still denied, until midnight.
	const lateEvening = MIDNIGHT + DAY - 90_000;
	expect(consumeAt(ledger, lateEvening)).toEqual({
		allowed: false,
		retryAfterSeconds: 90,
	});
	expect(consumeAt(ledger, MIDNIGHT + DAY - 1)).toEqual({
		allowed: false,
		retryAfterSeconds: 1,
	});
	expect(consumeAt(ledger, MIDNIGHT + DAY)).toEqual({ allowed: true });
});

test('counts survive the object being evicted and reopened', () => {
	const path = join(mkdtempSync(join(tmpdir(), 'demo-budget-')), 'do.sqlite');
	const now = MIDNIGHT + 30 * MINUTE;

	const first = new Database(path);
	const before = newBudget(sqliteStorage(first));
	for (let i = 0; i < 7; i++) expect(consumeAt(before, now).allowed).toBe(true);
	first.close();

	const reopened = new Database(path);
	const after = newBudget(sqliteStorage(reopened));
	const decisions = Array.from({ length: 5 }, () =>
		consumeAt(after, now + 1000),
	);
	expect(decisions.filter((d) => d.allowed)).toHaveLength(3);
	reopened.close();
});

test('a failed write rolls back both windows, so the attempt is not half-counted', () => {
	const db = new Database(':memory:');
	const storage = sqliteStorage(db);
	const ledger = newBudget(storage);
	const now = MIDNIGHT + MINUTE;
	expect(consumeAt(ledger, now).allowed).toBe(true);

	// Fail the second upsert (the day window) after the first one ran.
	let upserts = 0;
	const failing: ReturnType<typeof sqliteStorage> = {
		...storage,
		sql: {
			exec: (query: string, ...bindings: (string | number)[]) => {
				if (query.includes('INSERT') && ++upserts === 2) {
					throw new Error('storage failure');
				}
				return storage.sql.exec(query, ...bindings);
			},
		},
	};
	expect(() => consumeAt(newBudget(failing), now)).toThrow();

	const rows = db
		.query('SELECT scope, count FROM _demo_budget_windows ORDER BY scope')
		.all();
	expect(rows).toEqual([
		{ scope: 'day', count: 1 },
		{ scope: 'minute', count: 1 },
	]);
});

test('the Durable Object counts against the wall clock with its own storage', () => {
	const db = new Database(':memory:');
	const ctx = { storage: sqliteStorage(db) } as unknown as DurableObjectState;
	const budget = new DemoGenerationBudget(ctx, {} as Cloudflare.Env);

	setSystemTime(new Date(MIDNIGHT + 59_500));
	for (let i = 0; i < DEMO_BUDGET.perMinute; i++) {
		expect(budget.consume().allowed).toBe(true);
	}
	expect(budget.consume()).toEqual({ allowed: false, retryAfterSeconds: 1 });
	setSystemTime(new Date(MIDNIGHT + MINUTE));
	expect(budget.consume()).toEqual({ allowed: true });
});
