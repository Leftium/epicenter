import { expect, test } from 'bun:test';
import type {
	BaseRow,
	ReadonlyTable,
	TableReadError,
} from '@epicenter/workspace';
import { TableNewerWriterError, TableParseError } from '@epicenter/workspace';
import { Err, Ok } from 'wellcrafted/result';
import { fromTable } from './from-table.svelte.js';

// `bun test` runs `.svelte.ts` modules without the Svelte compiler, so the runes
// the source uses are plain globals here. `$derived` is stubbed as identity,
// which means the memoized bucket array getters (`nonconforming`, `newerWriter`)
// capture their value once at construction and never recompute.
// Consequence: seed-time bucket contents are observable, but the bucket maps the
// `observe()` callback mutates are NOT visible through the frozen getters.
//
// What stays fully testable is the live `rows` SvelteMap (a real Map returned by
// reference) and dispose. The `observe()` switch's bucket *destination* per error
// variant is guarded instead by its compile-time `error satisfies never`
// exhaustiveness; what the tests below pin is the rows-side decision the switch
// makes for every variant, plus seed classification and teardown.
(globalThis as unknown as { $derived: <T>(v: T) => T }).$derived = (v) => v;
(globalThis as unknown as { $state: <T>(v: T) => T }).$state = (v) => v;

type Row = BaseRow & { name: string };

type StoredEntry =
	| { kind: 'row'; row: Row }
	| { kind: 'error'; error: TableReadError };

const row = (id: string, name = id): StoredEntry => ({
	kind: 'row',
	row: { id, _v: 1, name } as Row,
});

const nonconforming = (id: string): StoredEntry => ({
	kind: 'error',
	error: TableParseError.ValidationFailed({
		id,
		errors: [{ path: '/name', message: 'required' }],
		row: {},
	}).error,
});

const newerWriter = (id: string): StoredEntry => ({
	kind: 'error',
	error: TableNewerWriterError.NewerWriter({
		id,
		version: 9,
		latestVersion: 1,
		row: {},
	}).error,
});

/**
 * A `ReadonlyTable` standing on a plain Map. `fromTable` only ever calls
 * `scan()`, `observe()`, and `get()`, so the rest throws to fail loud if the
 * contract widens. `fire(ids)` plays the role of a CRDT/local write landing.
 */
function createMockTable() {
	const store = new Map<string, StoredEntry>();
	let observer: ((changedIds: ReadonlySet<string>) => void) | undefined;

	const table = {
		scan() {
			const scan = {
				rows: [] as Row[],
				nonconforming: [] as TableParseError[],
				newerWriter: [] as TableNewerWriterError[],
			};
			for (const entry of store.values()) {
				if (entry.kind === 'row') {
					scan.rows.push(entry.row);
				} else if (entry.error.name === 'NewerWriter') {
					scan.newerWriter.push(entry.error);
				} else {
					scan.nonconforming.push(entry.error);
				}
			}
			return scan;
		},
		get(id: string) {
			const entry = store.get(id);
			if (!entry) return Ok(null);
			return entry.kind === 'row' ? Ok(entry.row) : Err(entry.error);
		},
		observe(callback: (changedIds: ReadonlySet<string>) => void) {
			observer = callback;
			return () => {
				observer = undefined;
			};
		},
	} as unknown as ReadonlyTable<Row>;

	return {
		table,
		store,
		fire(...ids: string[]) {
			if (!observer) throw new Error('no active observer');
			observer(new Set(ids));
		},
		isObserved: () => observer !== undefined,
	};
}

test('seed: scan routes conforming rows and each issue bucket', () => {
	const { table, store } = createMockTable();
	store.set('ok', row('ok'));
	store.set('bad', nonconforming('bad'));
	store.set('ahead', newerWriter('ahead'));

	const entries = fromTable(table);

	expect(entries.size).toBe(1);
	expect(entries.has('ok')).toBe(true);
	expect(entries.has('bad')).toBe(false);
	expect(entries.has('ahead')).toBe(false);

	expect(entries.nonconforming.map((e) => e.id)).toEqual(['bad']);
	expect(entries.newerWriter.map((e) => e.id)).toEqual(['ahead']);

	entries[Symbol.dispose]();
});

test('observe: a newly conforming id enters the row map', () => {
	const { table, store, fire } = createMockTable();
	const entries = fromTable(table);
	expect(entries.size).toBe(0);

	store.set('a', row('a', 'Ada'));
	fire('a');

	expect(entries.has('a')).toBe(true);
	expect(entries.get('a')?.name).toBe('Ada');

	entries[Symbol.dispose]();
});

test('observe: a deleted id leaves the row map', () => {
	const { table, store, fire } = createMockTable();
	store.set('a', row('a'));
	const entries = fromTable(table);
	expect(entries.has('a')).toBe(true);

	store.delete('a');
	fire('a');

	expect(entries.has('a')).toBe(false);

	entries[Symbol.dispose]();
});

test('observe: every error variant drops a previously conforming id from the row map', () => {
	for (const toError of [nonconforming, newerWriter]) {
		const { table, store, fire } = createMockTable();
		store.set('a', row('a'));
		const entries = fromTable(table);
		expect(entries.has('a')).toBe(true);

		store.set('a', toError('a'));
		fire('a');

		expect(entries.has('a')).toBe(false);

		entries[Symbol.dispose]();
	}
});

test('observe: a previously failing id re-enters the row map once it conforms', () => {
	const { table, store, fire } = createMockTable();
	store.set('a', nonconforming('a'));
	const entries = fromTable(table);
	expect(entries.has('a')).toBe(false);

	store.set('a', row('a', 'fixed'));
	fire('a');

	expect(entries.has('a')).toBe(true);
	expect(entries.get('a')?.name).toBe('fixed');

	entries[Symbol.dispose]();
});

test('dispose stops observation and is idempotent', () => {
	const { table, fire, isObserved } = createMockTable();
	const entries = fromTable(table);
	expect(isObserved()).toBe(true);

	entries[Symbol.dispose]();
	expect(isObserved()).toBe(false);
	expect(() => fire('a')).toThrow('no active observer');

	expect(() => entries[Symbol.dispose]()).not.toThrow();
});
