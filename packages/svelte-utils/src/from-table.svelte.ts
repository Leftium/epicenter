import type {
	BaseRow,
	ReadonlyTable,
	TableNewerWriterError,
	TableParseError,
	TableUnreadableError,
} from '@epicenter/workspace';
import { SvelteMap } from 'svelte/reactivity';

/**
 * A reactive `SvelteMap` of a table's conforming rows, with the table's three
 * issue buckets attached as properties.
 *
 * Every surface updates granularly from one `observe()` subscription. A changed
 * id lands in the map when it parses and in exactly one issue bucket
 * (`nonconforming`, `newerWriter`, `unreadable`) when it does not. No surface
 * ever re-reads the whole table on change.
 */
export type ReactiveTableMap<TRow extends BaseRow> = SvelteMap<string, TRow> &
	Disposable & {
		/** Stored entries this binary should understand but cannot parse. */
		readonly nonconforming: TableParseError[];
		/** Stored entries written by a newer binary than this one. */
		readonly newerWriter: TableNewerWriterError[];
		/** Encrypted entries this device holds no usable key for. */
		readonly unreadable: TableUnreadableError[];
	};

/**
 * Create a reactive binding to a workspace table from a single `observe()`
 * subscription.
 *
 * The returned value is a `SvelteMap<id, Row>` of the conforming rows that
 * stays in sync via granular per-row updates: only changed rows trigger
 * re-renders, not the entire collection. The same subscription classifies each
 * changed id with `get(id)` and routes the ones that do not parse into the
 * three issue buckets (`nonconforming`, `newerWriter`, `unreadable`), so a view
 * can surface what the rows hide without a second subscription and without an
 * O(n) re-scan: the classification rides the per-id delta the row map already
 * walks.
 *
 * Read-only: mutations go through `table.set()`, `table.update()`, etc. The
 * observer picks up changes from both local writes and remote CRDT sync.
 *
 * The returned map is disposable. Call `[Symbol.dispose]()` when the binding
 * has a shorter lifetime than the workspace, such as component teardown,
 * workspace switching, HMR, or tests.
 *
 * @example
 * ```typescript
 * const entries = fromTable(workspaceClient.tables.entries);
 *
 * // Per-item access (reactive):
 * const entry = entries.get(id);
 *
 * // Iterate the conforming rows (reactive):
 * for (const [id, entry] of entries) { ... }
 *
 * // Issue buckets (reactive):
 * entries.nonconforming.length;
 * entries.newerWriter.length;
 * entries.unreadable.length;
 *
 * // Teardown:
 * entries[Symbol.dispose]();
 * ```
 */
export function fromTable<TRow extends BaseRow>(
	table: ReadonlyTable<TRow>,
): ReactiveTableMap<TRow> {
	const rows = new SvelteMap<string, TRow>();
	const nonconforming = new SvelteMap<string, TableParseError>();
	const newerWriter = new SvelteMap<string, TableNewerWriterError>();
	const unreadable = new SvelteMap<string, TableUnreadableError>();

	// Seed every surface from one classified scan: conforming rows into the map,
	// the rest into their issue bucket. After this each id lives in exactly one.
	const initial = table.scan();
	for (const row of initial.rows) rows.set(row.id, row);
	for (const e of initial.nonconforming) nonconforming.set(e.id, e);
	for (const e of initial.newerWriter) newerWriter.set(e.id, e);
	for (const e of initial.unreadable) unreadable.set(e.id, e);

	const unobserve = table.observe((changedIds) => {
		for (const id of changedIds) {
			// A changed id belongs to exactly one surface. Clear it from the issue
			// buckets, then place it by re-reading its classified state. `get(id)`
			// returns the conforming row or the same error variant `scan()` would
			// have bucketed it under, so the map and the buckets can never disagree.
			nonconforming.delete(id);
			newerWriter.delete(id);
			unreadable.delete(id);
			const { data: row, error } = table.get(id);
			if (!error) {
				if (row === null) rows.delete(id);
				else rows.set(id, row);
				continue;
			}
			rows.delete(id);
			// Route by variant the same way `scan()` does, so adding a new
			// TableReadError variant fails the build here instead of silently
			// falling through into `nonconforming`.
			switch (error.name) {
				case 'NewerWriter':
					newerWriter.set(id, error);
					break;
				case 'UnreadableRow':
					unreadable.set(id, error);
					break;
				case 'UnknownVersion':
				case 'ValidationFailed':
				case 'MigrationFailed':
					nonconforming.set(id, error);
					break;
				default:
					error satisfies never;
			}
		}
	});

	// Memoized array views: each recomputes only when its bucket map mutates,
	// not on every property read, and hands out a stable reference in between.
	const nonconformingList = $derived([...nonconforming.values()]);
	const newerWriterList = $derived([...newerWriter.values()]);
	const unreadableList = $derived([...unreadable.values()]);

	Object.defineProperties(rows, {
		nonconforming: { get: () => nonconformingList, enumerable: false },
		newerWriter: { get: () => newerWriterList, enumerable: false },
		unreadable: { get: () => unreadableList, enumerable: false },
		[Symbol.dispose]: {
			// `unobserve` is idempotent (it deletes a handler from a Set), so a
			// double dispose is a harmless no-op; no guard needed.
			value: unobserve,
			enumerable: false,
		},
	});

	return rows as ReactiveTableMap<TRow>;
}
