import type {
	BaseRow,
	ReadonlyTable,
	TableNewerWriterError,
	TableParseError,
} from '@epicenter/workspace';
import { createSubscriber } from 'svelte/reactivity';

/**
 * A read-only reactive view of a workspace table: the conforming rows plus the
 * table's two issue buckets, all driven by one `observe()` subscription.
 *
 * The view holds no state. Every surface reads live through the table, so it can
 * never disagree with storage and there is nothing to dispose. Reads inside an
 * effect (a component, a `$derived`) re-run when the table changes; reads outside
 * one return the current value without subscribing.
 */
export type ReadonlyTableView<TRow extends BaseRow> = {
	/**
	 * Every conforming row, recomputed once per change. The array is the view's
	 * memoized scan, shared between reads, so the type is `readonly`: mutating it
	 * (e.g. `.sort()`) in place would corrupt that shared value and is a compile
	 * error. Take a copy first, e.g. `all.toSorted(...)`.
	 */
	readonly all: readonly TRow[];
	/** Stored entries this binary should understand but cannot parse. */
	readonly nonconforming: readonly TableParseError[];
	/** Stored entries written by a newer binary than this one. */
	readonly newerWriter: readonly TableNewerWriterError[];
	/** A single conforming row by id, or `undefined` if absent or unreadable. */
	byId(id: string): TRow | undefined;
};

/**
 * Create a read-only reactive view of a workspace table from a single
 * `observe()` subscription.
 *
 * `all`, `nonconforming`, and `newerWriter` share one memoized `scan()`: the
 * scan recomputes once when the table changes, not once per surface read. The
 * table caches parsed rows by stored-value identity, so an unchanged row keeps
 * its object reference across scans and only changed rows are reparsed; the view
 * does not need a mirror of its own to stay incremental.
 *
 * `byId` reads straight through the table per call. It is reactive (it
 * subscribes), but coarsely: any table change re-runs it, where a per-key mirror
 * would re-run only on a change to that id. At table sizes below roughly ten
 * thousand rows with human-speed edits this is not worth a per-key subscription;
 * add one keyed by id if profiling ever says otherwise.
 *
 * The view self-manages its lifetime: `observe()` attaches when the first effect
 * starts reading and detaches a microtask after the last one stops. There is no
 * `[Symbol.dispose]` to thread through consumers.
 *
 * Read-only: mutations go through `table.set()`, `table.update()`, etc. The
 * observer picks up changes from both local writes and remote CRDT sync.
 *
 * @example
 * ```typescript
 * const entries = fromTable(workspaceClient.tables.entries);
 *
 * entries.all;                  // TRow[] (reactive)
 * entries.byId(id);             // TRow | undefined (reactive)
 * entries.nonconforming.length; // issue bucket (reactive)
 * ```
 */
export function fromTable<TRow extends BaseRow>(
	table: ReadonlyTable<TRow>,
): ReadonlyTableView<TRow> {
	const subscribe = createSubscriber((update) => table.observe(update));
	// One scan feeds every list surface and recomputes once per change. Reading
	// `scanned` is what registers the dependency, so the list getters need no
	// separate `subscribe()` call.
	const scanned = $derived.by(() => {
		subscribe();
		return table.scan();
	});

	return {
		get all() {
			return scanned.rows;
		},
		get nonconforming() {
			return scanned.nonconforming;
		},
		get newerWriter() {
			return scanned.newerWriter;
		},
		byId(id: string): TRow | undefined {
			subscribe();
			return table.get(id).data ?? undefined;
		},
	};
}
