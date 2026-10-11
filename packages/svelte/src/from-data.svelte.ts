/**
 * Reactive reads over one opened Epicenter data handle (ADR-0500).
 *
 * `fromData(data)` hands back the same store with its declared reads made
 * reactive: `tables.<name>`, `kv`, and `persistence`, with the names, row
 * types, and write verbs the declaration gives them. Each read registers a
 * Svelte dependency and then calls the native method. Nothing here holds a
 * row value or a diagnostic, so a read sees what the native read sees:
 * validation, writes inside the current transaction, body availability, and
 * the rejection a closed store raises.
 *
 * One subscription per table wakes that table's readers on each table
 * commit. It attaches on the first reactive reader and detaches after the
 * last, so a remounted reader reads current rows rather than a cache from
 * before it looked away. Imperative reads attach nothing. Body text edits are
 * not table commits; an editor hears them through the table's own `watch`.
 *
 * Inputs are native plain-object handles with closure-bound methods. Every
 * other member keeps its own descriptor and identity, which matters for
 * capabilities looked up by object identity, such as `sync`. Opening,
 * closing, sync, and writes stay owned by the original handle.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   const honeycrisp = fromData(data);
 *   const notes = honeycrisp.tables.notes;
 *   const active = $derived(notes.rows.filter((n) => n.deletedAt === null));
 * </script>
 * <button onclick={() => notes.create({ title: '' })}>New</button>
 * {#each active as note (note.id)}...{/each}
 * ```
 */
import { createSubscriber } from 'svelte/reactivity';
import type { Brand } from 'wellcrafted/brand';
import { type AdaptableKv, fromKv, overrideMembers } from './from-kv.svelte.js';

/**
 * The read surface shared by every typed table handle.
 *
 * Structural rather than imported: a typed handle narrows `create` and
 * `update` to its own input type, so it is not assignable to the untyped
 * `TableHandle`. Constraining on reads accepts every typed handle while
 * `fromData` returns the caller's exact type.
 */
type AdaptableTable = {
	readonly rows: unknown[];
	readonly nonconforming: readonly { readonly id: string }[];
	ids(): string[];
	get(rowId: string): unknown;
	body(rowId: string): unknown;
	subscribe(listener: (rowIds: readonly string[]) => void): () => void;
};

/** The persistence status read and the feed that invalidates it. */
type AdaptablePersistence = {
	get(): unknown;
	subscribe(listener: () => void): () => void;
};

/**
 * The native capabilities whose reads this adapter tracks.
 *
 * Sync is absent on purpose: its status is a fact about a remote socket,
 * polled rather than subscribed, and a reactive wrapper must not present it
 * as local state.
 */
export type AdaptableData = {
	tables: Record<string, AdaptableTable>;
	kv: AdaptableKv;
	persistence: AdaptablePersistence;
};

/**
 * The same store type, branded so a raw store cannot stand in where tracked
 * reads are required, and `fromData(fromData(x))` does not compile.
 */
export type ReactiveData<TData extends AdaptableData> = TData &
	Brand<'ReactiveData'>;

const wrappers = new WeakMap<AdaptableData, ReactiveData<AdaptableData>>();

/** Make one opened store's declared reads reactive, holding no data. */
export function fromData<TData extends AdaptableData>(
	data: TData,
): ReactiveData<TData> {
	const existing = wrappers.get(data);
	if (existing) return existing as ReactiveData<TData>;
	const reactive = overrideMembers(data, {
		tables: {
			value: Object.freeze(
				Object.fromEntries(
					Object.entries(data.tables).map(([name, table]) => [
						name,
						reactiveTable(table),
					]),
				),
			),
		},
		kv: { value: fromKv(data.kv) },
		persistence: { value: reactivePersistence(data.persistence) },
	}) as ReactiveData<TData>;
	wrappers.set(data, reactive);
	return reactive;
}

/**
 * Persistence status, read through. The store notifies only when the status
 * changes, so a run of failed flushes wakes a reader once.
 */
function reactivePersistence<TPersistence extends AdaptablePersistence>(
	persistence: TPersistence,
): TPersistence {
	const track = createSubscriber((update) => persistence.subscribe(update));
	return overrideMembers(persistence, {
		get: {
			value: () => {
				track();
				return persistence.get();
			},
		},
	});
}

/**
 * One table, read through. Any commit to the table wakes all of its readers,
 * including point and ID reads whose answers did not change; full reads
 * repeat native validation. ADR-0500 accepts that cost for current callers.
 */
function reactiveTable<TTable extends AdaptableTable>(table: TTable): TTable {
	const track = createSubscriber((update) => table.subscribe(() => update()));
	return overrideMembers(table, {
		rows: {
			get() {
				track();
				return table.rows;
			},
		},
		nonconforming: {
			get() {
				track();
				return table.nonconforming;
			},
		},
		ids: {
			value: () => {
				track();
				return table.ids();
			},
		},
		get: {
			value: (rowId: string) => {
				track();
				return table.get(rowId);
			},
		},
		body: {
			value: (rowId: string) => {
				track();
				return table.body(rowId);
			},
		},
	});
}
