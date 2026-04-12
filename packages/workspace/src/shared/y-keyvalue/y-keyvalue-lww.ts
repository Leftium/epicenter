/**
 * # YKeyValueLww - Last-Write-Wins Key-Value Store for Yjs
 *
 * A timestamp-based variant of YKeyValue that uses last-write-wins (LWW) conflict
 * resolution instead of positional ordering.
 *
 * **See also**: `y-keyvalue.ts` for the simpler positional (rightmost-wins) version.
 *
 * ## When to Use This vs YKeyValue
 *
 * | Scenario | Use `YKeyValue` | Use `YKeyValueLww` |
 * |----------|-----------------|-------------------|
 * | Real-time collab | Yes | Either |
 * | Offline-first, multi-device | No | Yes |
 * | Clock sync unreliable | Yes | No |
 * | Need "latest edit wins" | No | Yes |
 *
 * ## How It Works
 *
 * Each entry stores a timestamp alongside the key and value:
 *
 * ```
 * { key: 'user-1', val: { name: 'Alice' }, ts: 1706200000000 }
 * ```
 *
 * When conflicts occur (two clients set the same key while offline), the entry
 * with the **higher timestamp wins**. This gives intuitive "last write wins"
 * semantics.
 *
 * ```
 * Client A (2:00pm): { key: 'x', val: 'A', ts: 1706200400000 }
 * Client B (3:00pm): { key: 'x', val: 'B', ts: 1706204000000 }
 *
 * After sync: B wins (higher timestamp), regardless of sync order
 * ```
 *
 * ## Timestamp Generation
 *
 * Uses a monotonic clock that guarantees:
 * - Local writes always have increasing timestamps (no same-millisecond collisions)
 * - Clock regression is handled (ignores backward jumps)
 * - Cross-device convergence by adopting higher timestamps from synced entries
 *
 * ```typescript
 * // Simplified logic:
 * const now = Date.now();
 * this.lastTimestamp = now > this.lastTimestamp ? now : this.lastTimestamp + 1;
 * return this.lastTimestamp;
 * ```
 *
 * Tracks the maximum timestamp from both local writes and remote synced entries.
 * Devices with slow clocks "catch up" after syncing, preventing their writes from
 * losing to stale timestamps.
 *
 * ## Tiebreaker
 *
 * When timestamps are equal (rare - requires synchronized clocks AND coincidental
 * timing), falls back to positional ordering (rightmost wins). This is deterministic
 * because Yjs's CRDT merge produces consistent ordering based on clientID.
 *
 * ## Storage Complexity
 *
 * With `gc:true` (the default), storage is `O(active data) + O(unique devices)`.
 * Deleted entries, overwritten values, and edit history are garbage collected into
 * compact GC structs. A store with 20 active keys stays at roughly the same size
 * whether it was created yesterday or has processed 52,000 operations. The only
 * additional overhead is ~22 bytes per unique Yjs clientID that has ever written
 * to the doc. With `gc:false`, this property breaks—storage grows with operation
 * count. See `docs/articles/yjs-storage-efficiency/storage-scales-with-data-not-history.md`.
 * ## Limitations
 *
 * - Future clock dominance: If a device's clock is far in the future, its writes dominate
 *   indefinitely. All devices adopt the highest timestamp seen, so writes won't catch up
 *   until wall-clock reaches that point. Rare with NTP, but be aware in environments with
 *   unreliable time sync.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs';
 * import { YKeyValueLww } from './y-keyvalue-lww';
 *
 * const doc = new Y.Doc();
 * const yarray = doc.getArray<{ key: string; val: any; ts: number }>('data');
 * const kv = new YKeyValueLww(yarray);
 *
 * kv.set('user1', { name: 'Alice' });  // ts auto-generated
 * kv.get('user1');  // { name: 'Alice' }
 * ```
 */
import type * as Y from 'yjs';
import { lazy } from '../lazy.js';

/**
 * Entry stored in the Y.Array. The `ts` field enables last-write-wins conflict resolution.
 *
 * Field names are intentionally short (`val`, `ts`) to minimize serialized storage size -
 * these entries are persisted and synced.
 */
export type YKeyValueLwwEntry<T> = { key: string; val: T; ts: number };

export type YKeyValueLwwChange<T> =
	| { action: 'add'; newValue: T }
	| { action: 'update'; newValue: T }
	| { action: 'delete' };

export type YKeyValueLwwChangeHandler<T> = (
	changes: Map<string, YKeyValueLwwChange<T>>,
	transaction: Y.Transaction,
) => void;

/**
 * Transaction origin for observer dedup deletions. When the observer resolves
 * LWW conflicts, it deletes loser entries in a nested transaction. That nested
 * transaction would trigger the observer again — but the re-entrant call is
 * always a no-op (_map already points to the winner, so the reference equality
 * check in the deletion handler fails). Marking the transaction with this origin
 * lets the observer skip it entirely, avoiding useless work.
 *
 * This follows the same pattern as REENCRYPT_ORIGIN in the encrypted wrapper.
 */
const DEDUP_ORIGIN = Symbol('dedup');

export class YKeyValueLww<T> {
	/** The underlying Y.Array that stores `{key, val, ts}` entries. */
	readonly yarray: Y.Array<YKeyValueLwwEntry<T>>;

	/** The Y.Doc that owns this array. Required for transactions. */
	readonly doc: Y.Doc;

	/** Mutable in-memory index. Written exclusively by the constructor and observer. */
	private readonly _map = new Map<string, YKeyValueLwwEntry<T>>();

	/**
	 * Read-only view of the in-memory index for O(1) key lookups.
	 *
	 * Written exclusively by the observer and constructor. External consumers
	 * (e.g. the encrypted wrapper) read via iteration, `.get()`, and `.size`.
	 * The `set()` method never writes to this map—the observer is the sole writer.
	 *
	 * @see pending for how immediate reads work after `set()`
	 */
	readonly map: ReadonlyMap<string, YKeyValueLwwEntry<T>> = this._map;

	/**
	 * Pending entries written by `set()` but not yet processed by the observer.
	 *
	 * ## Why This Exists
	 *
	 * When `set()` is called inside a batch/transaction, the observer doesn't fire
	 * until the outer transaction ends. Without `pending`, `get()` would return
	 * undefined for values just written.
	 *
	 * ## Data Flow
	 *
	 * ```
	 * set('foo', 1) is called:
	 * ─────────────────────────────────────────────────────────────
	 *
	 *   set()
	 *     │
	 *     ├───► pending.set('foo', entry)    ← For immediate reads
	 *     │
	 *     └───► yarray.push(entry)           ← Source of truth (CRDT)
	 *                 │
	 *                 │  (observer fires after transaction ends)
	 *                 ▼
	 *           Observer
	 *                 │
	 *                 ├───► map.set('foo', entry)      ← Observer writes to map
	 *                 │
	 *                 └───► pending.delete('foo')      ← Clears pending
	 *
	 *
	 * get('foo') is called:
	 * ─────────────────────────────────────────────────────────────
	 *
	 *   get()
	 *     │
	 *     ├───► Check pending.get('foo')  ← If found, return it
	 *     │
	 *     └───► Check map.get('foo')      ← Fallback to map
	 * ```
	 *
	 * ## Who Writes Where
	 *
	 * | Writer   | `pending` | `Y.Array` | `map`     |
	 * |----------|-----------|-----------|-----------|
	 * | `set()`  | ✅ writes | ✅ writes | ❌ never  |
	 * | Observer | ❌ never  | ❌ never  | ✅ writes |
	 */
	private pending: Map<string, YKeyValueLwwEntry<T>> = new Map();

	/**
	 * Keys deleted by `delete()` but not yet processed by the observer.
	 *
	 * Symmetric counterpart to `pending` — while `pending` tracks writes not yet
	 * in `map`, `pendingDeletes` tracks deletions not yet removed from `map`.
	 * This prevents stale reads after `delete()` during a batch/transaction.
	 */
	private pendingDeletes: Set<string> = new Set();

	/** Registered change handlers. */
	private changeHandlers: Set<YKeyValueLwwChangeHandler<T>> = new Set();

	/** Stored observer reference for cleanup in dispose(). */
	private _observer!: (
		event: Y.YArrayEvent<YKeyValueLwwEntry<T>>,
		transaction: Y.Transaction,
	) => void;

	/**
	 * Last timestamp used for monotonic clock.
	 *
	 * **Primary purpose**: Ensures rapid writes on the SAME device get sequential timestamps,
	 * preventing same-millisecond collisions where two writes would get identical timestamps.
	 *
	 * Tracks the highest timestamp seen from BOTH local writes and remote synced entries.
	 * This ensures:
	 * 1. **Same-millisecond writes on same device**: Always get unique, sequential timestamps
	 *    - Write at t=1000 → ts=1000
	 *    - Write at t=1000 (same ms!) → ts=1001 (incremented)
	 *    - Write at t=1000 (same ms!) → ts=1002 (incremented again)
	 *
	 * 2. **Clock regression**: If system clock goes backward (NTP adjustment), continue
	 *    incrementing from lastTimestamp instead of going backward
	 *
	 * 3. **Self-healing from clock skew**: After syncing with devices that have faster clocks,
	 *    adopt their higher timestamps so future local writes win conflicts
	 *    - Example: Device A's clock at 1000ms syncs entry from Device B with ts=5000ms
	 *    - Device A's lastTimestamp becomes 5000, next write uses 5001 (not 1001)
	 *    - Prevents Device A from writing "old" timestamps that would lose to Device B
	 */
	private lastTimestamp = 0;

	/**
	 * Create a YKeyValueLww wrapper around an existing Y.Array.
	 *
	 * On construction:
	 * 1. Scans the array to build the in-memory Map, keeping highest-timestamp entries
	 * 2. Removes duplicate keys (losers based on timestamp comparison)
	 * 3. Sets up an observer to handle future changes with LWW semantics
	 */
	constructor(yarray: Y.Array<YKeyValueLwwEntry<T>>) {
		this.yarray = yarray;
		this.doc = yarray.doc as Y.Doc;

		const entries = yarray.toArray();
		const indicesToDelete: number[] = [];

		// First pass: find winners by timestamp
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (!entry) continue;
			const existing = this._map.get(entry.key);

			if (!existing) {
				this._map.set(entry.key, entry);
			} else {
				if (entry.ts > existing.ts) {
					// New entry wins, mark old for deletion
					const oldIndex = entries.indexOf(existing);
					if (oldIndex !== -1) indicesToDelete.push(oldIndex);
					this._map.set(entry.key, entry);
				} else if (entry.ts < existing.ts) {
					// Old entry wins, mark new for deletion
					indicesToDelete.push(i);
				} else {
					// Equal timestamps: keep later one (rightmost), delete earlier
					const oldIndex = entries.indexOf(existing);
					if (oldIndex !== -1 && oldIndex < i) {
						indicesToDelete.push(oldIndex);
						this._map.set(entry.key, entry);
					} else {
						indicesToDelete.push(i);
					}
				}
			}

			// Track max timestamp for monotonic clock (including remote entries)
			// This ensures our next local write will have a higher timestamp than
			// any entry we've seen, preventing us from writing "old" timestamps
			// that would lose conflicts to devices with faster clocks
			if (entry.ts > this.lastTimestamp) this.lastTimestamp = entry.ts;
		}

		// Delete losers
		if (indicesToDelete.length > 0) {
			this.doc.transact(() => {
				// Sort descending to preserve indices during deletion
				indicesToDelete.sort((a, b) => b - a);
				for (const index of indicesToDelete) {
					yarray.delete(index);
				}
			});
		}

		// Set up observer for future changes
		this._observer = (event, transaction) => {
			// Dedup deletions are always no-ops — _map already has the winner.
			// Skip entirely to avoid useless work on re-entrant observer calls.
			if (transaction.origin === DEDUP_ORIGIN) return;
			const changes = new Map<string, YKeyValueLwwChange<T>>();
			const addedEntries: YKeyValueLwwEntry<T>[] = [];
			const deletedCurrentKeys = new Set<string>();

			// Collect added entries
			for (const addedItem of event.changes.added) {
				for (const addedEntry of addedItem.content.getContent() as YKeyValueLwwEntry<T>[]) {
					addedEntries.push(addedEntry);

					// Track max timestamp from synced entries (self-healing behavior)
					if (addedEntry.ts > this.lastTimestamp)
						this.lastTimestamp = addedEntry.ts;
				}
			}

			// Handle deletions first
			event.changes.deleted.forEach((deletedItem) => {
				deletedItem.content
					.getContent()
					.forEach((entry: YKeyValueLwwEntry<T>) => {
						// Always clear pendingDeletes for this key — even if the ref-equality
						// check fails (e.g. set+delete in same txn where entry never reached map)
						this.pendingDeletes.delete(entry.key);

						// Reference equality: only process if this is the entry we have cached
						if (this._map.get(entry.key) === entry) {
							deletedCurrentKeys.add(entry.key);
							this._map.delete(entry.key);
							changes.set(entry.key, { action: 'delete' });
						}
					});
			});

			// Process added entries with LWW logic
			const indicesToDelete: number[] = [];

			/**
			 * Lazy array snapshot and entry-to-index map for conflict resolution.
			 *
			 * Both use the `lazy()` helper—a function that computes its value on
			 * first call, then returns the cached result on subsequent calls. This
			 * avoids the O(n) `toArray()` copy entirely when there are no conflicts
			 * (the common case for bulk inserts of new keys).
			 *
			 * `getEntryIndexMap` builds on `getAllEntries`—calling it triggers the
			 * `toArray()` if it hasn't happened yet, then builds a Map<entry, index>
			 * for O(1) index lookups. This replaces the old `.indexOf()` calls that
			 * were O(n) each, which caused O(n²) behavior during bulk updates.
			 *
			 * Both caches are scoped to this single observer invocation—they're
			 * garbage collected when the callback returns. No manual cleanup needed.
			 */
			const getAllEntries = lazy(() => yarray.toArray());
			const getEntryIndexMap = lazy(() => {
				const entries = getAllEntries();
				const map = new Map<YKeyValueLwwEntry<T>, number>();
				for (let i = 0; i < entries.length; i++) {
					const entry = entries[i];
					if (entry) map.set(entry, i);
				}
				return map;
			});
			const getEntryIndex = (entry: YKeyValueLwwEntry<T>): number => {
				// For individual updates (1-4 added entries), indexOf with reference
				// equality is faster than building a Map. The Map's O(n) build cost
				// only amortizes over many lookups (batched updates).
				if (addedEntries.length <= 4) {
					return getAllEntries().indexOf(entry);
				}
				return getEntryIndexMap().get(entry) ?? -1;
			};

			for (const newEntry of addedEntries) {
				const existing = this._map.get(newEntry.key);

				if (!existing) {
					if (
						transaction.local &&
						deletedCurrentKeys.has(newEntry.key) &&
						this.pending.get(newEntry.key) !== newEntry
					) {
						const newIndex = getEntryIndex(newEntry);
						if (newIndex !== -1) indicesToDelete.push(newIndex);
						continue;
					}

					// New key: just update the map. No array operations needed.
					const deleteEvent = changes.get(newEntry.key);
					if (deleteEvent && deleteEvent.action === 'delete') {
						// Was deleted in same transaction, now re-added
						changes.set(newEntry.key, {
							action: 'update',
							newValue: newEntry.val,
						});
					} else {
						changes.set(newEntry.key, {
							action: 'add',
							newValue: newEntry.val,
						});
					}
					this._map.set(newEntry.key, newEntry);
					this.pendingDeletes.delete(newEntry.key);
				} else {
					// Conflict: key exists in map. Must compare timestamps to determine winner,
					// then find the loser's index in the array to delete it. This is the only
					// path that calls getAllEntries(), triggering the O(n) toArray() copy.
					if (newEntry.ts > existing.ts) {
						// New entry wins: delete old from array
						changes.set(newEntry.key, {
							action: 'update',
							newValue: newEntry.val,
						});

						// Mark old entry for deletion
						const oldIndex = getEntryIndex(existing);
						if (oldIndex !== -1) indicesToDelete.push(oldIndex);

						this._map.set(newEntry.key, newEntry);
						this.pendingDeletes.delete(newEntry.key);
					} else if (newEntry.ts < existing.ts) {
						// Old entry wins: delete new from array
						const newIndex = getEntryIndex(newEntry);
						if (newIndex !== -1) indicesToDelete.push(newIndex);
					} else {
						// Equal timestamps: positional tiebreaker (rightmost wins)
						const oldIndex = getEntryIndex(existing);
						const newIndex = getEntryIndex(newEntry);

						if (newIndex > oldIndex) {
							// New is rightmost, it wins
							changes.set(newEntry.key, {
								action: 'update',
								newValue: newEntry.val,
							});
							if (oldIndex !== -1) indicesToDelete.push(oldIndex);
							this._map.set(newEntry.key, newEntry);
							this.pendingDeletes.delete(newEntry.key);
						} else {
							// Old is rightmost, delete new
							if (newIndex !== -1) indicesToDelete.push(newIndex);
						}
					}
				}

				// Clear from pending once processed (whether entry won or lost).
				// Use reference equality to only clear if it's the exact entry we added.
				if (this.pending.get(newEntry.key) === newEntry) {
					this.pending.delete(newEntry.key);
				}
			}

			// Delete loser entries
			if (indicesToDelete.length > 0) {
				this.doc.transact(() => {
					indicesToDelete.sort((a, b) => b - a);
					for (const index of indicesToDelete) {
						yarray.delete(index);
					}
				}, DEDUP_ORIGIN);
			}

			// Emit change events
			if (changes.size > 0) {
				for (const handler of this.changeHandlers) {
					handler(changes, transaction);
				}
			}
		};
		yarray.observe(this._observer);
	}

	/**
	 * Generate a monotonic timestamp for local writes.
	 *
	 * **Core guarantee**: Returns a timestamp that is ALWAYS strictly greater than the
	 * previous one, ensuring sequential ordering of writes on this device.
	 *
	 * Handles three edge cases:
	 * 1. **Same-millisecond writes** (primary use case):
	 *    Multiple rapid writes in same millisecond get sequential timestamps
	 *    - kv.set('x', 1) at t=1000 → ts=1000
	 *    - kv.set('y', 2) at t=1000 → ts=1001 (incremented, not duplicate)
	 *    - kv.set('z', 3) at t=1000 → ts=1002 (incremented again)
	 *
	 * 2. **Clock regression**:
	 *    If system clock goes backward (NTP adjustment), continue incrementing
	 *    instead of going backward (maintains monotonicity)
	 *
	 * 3. **Post-sync convergence**:
	 *    After syncing entries with higher timestamps from other devices,
	 *    local writes continue from the highest timestamp seen (self-healing)
	 *
	 * Algorithm:
	 * - If Date.now() > lastTimestamp: use wall clock time (normal case)
	 * - Otherwise: increment lastTimestamp by 1 (handles all three edge cases)
	 */
	private getTimestamp(): number {
		const now = Date.now();
		this.lastTimestamp =
			now > this.lastTimestamp ? now : this.lastTimestamp + 1;
		return this.lastTimestamp;
	}

	/**
	 * Delete the entry with the given key from the Y.Array.
	 *
	 * The data structure maintains at most one entry per key (duplicates are
	 * cleaned up on construction and during sync), so this only deletes one entry.
	 */
	private deleteEntryByKey(key: string): void {
		const index = this.yarray.toArray().findIndex((e) => e.key === key);
		if (index !== -1) this.yarray.delete(index);
	}

	/**
	 * Check if the Y.Doc is currently inside an active transaction.
	 *
	 * Uses Yjs internal `_transaction` property. This is stable across Yjs versions
	 * but is technically internal API (underscore prefix).
	 */
	private isInTransaction(): boolean {
		return this.doc._transaction !== null;
	}

	/**
	 * Set a key-value pair with automatic timestamp.
	 * The timestamp enables LWW conflict resolution during sync.
	 *
	 * For existing keys, eagerly deletes the old entry before pushing the new one.
	 * This keeps the observer's job simple—it sees a clean add with no conflicts.
	 *
	 * For bulk updates (1K+ rows), use {@link bulkSet} instead. It skips the
	 * per-key delete and lets the observer batch-resolve all conflicts in one pass,
	 * turning O(n²) into O(n). See `bulkSet` JSDoc for the full explanation.
	 *
	 * ## Why `set()` eagerly deletes but `bulkSet()` defers
	 *
	 * `deleteEntryByKey()` scans the Y.Array to find the old entry — O(n) per call.
	 * For a single `set()`, that O(n) is fine. For 10K `set()` calls in a loop,
	 * it's 10K × O(n) = O(n²). `bulkSet` avoids this by pushing all entries first,
	 * then letting the observer find and remove old entries using a pre-built index
	 * Map (one O(n) scan + O(1) per lookup = O(n) total).
	 *
	 * ```
	 * set() for existing key:
	 *   deleteEntryByKey(key)    ← O(n) scan, removes old entry
	 *   yarray.push([entry])     ← O(1)
	 *   observer fires            ← no conflicts (old entry already gone)
	 *
	 * bulkSet() for 10K existing keys:
	 *   for each: yarray.push([entry])      ← O(1) × 10K, NO delete
	 *   observer fires ONCE:
	 *     builds entryIndexMap               ← O(n) — one scan
	 *     resolves 10K conflicts             ← O(1) each via Map.get
	 *     batch deletes losers               ← O(k)
	 * ```
	 */
	set(key: string, val: T): void {
		const entry: YKeyValueLwwEntry<T> = { key, val, ts: this.getTimestamp() };

		// Track in pending for immediate reads via get()
		this.pending.set(key, entry);
		this.pendingDeletes.delete(key);

		const doWork = () => {
			if (this._map.has(key)) this.deleteEntryByKey(key);
			this.yarray.push([entry]);
		};

		// Avoid nested transactions - if already in one, just do the work
		if (this.isInTransaction()) {
			doWork();
		} else {
			this.doc.transact(doWork);
		}

		// DO NOT update this.map here - observer is the sole writer to map
	}

	/**
	 * Set many key-value pairs in one transaction.
	 *
	 * Unlike {@link set}, this intentionally skips `deleteEntryByKey()` for existing
	 * keys. Instead, all entries are pushed to the Y.Array, and the observer resolves
	 * duplicate-key conflicts in a single pass when the transaction ends.
	 *
	 * ## Why this is faster than calling `set()` in a loop
	 *
	 * `set()` calls `deleteEntryByKey()` per key — an O(n) array scan. In a loop:
	 * N calls × O(n) scan = O(n²). `bulkSet` defers all cleanup to the observer,
	 * which builds an `entryIndexMap` (Map<Entry, index>) from one `toArray()` call
	 * and resolves each conflict with an O(1) Map lookup. Total: O(n).
	 *
	 * The observer's conflict resolution already exists for multi-device sync — when
	 * two clients set the same key offline. `bulkSet` reuses that exact same path.
	 *
	 * ## When to use
	 *
	 * - Importing 1K+ rows: `ykv.bulkSet(entries)` in a transaction
	 * - For chunked imports with progress, use `TableHelper.bulkSet()` which wraps
	 *   this method with chunking, `onProgress`, and event-loop yielding
	 * - For < 100 rows, `set()` in a `doc.transact()` is simpler and equivalent
	 *
	 * @example
	 * ```typescript
	 * ykv.bulkSet([
	 *   { key: 'row-1', val: { title: 'First' } },
	 *   { key: 'row-2', val: { title: 'Second' } },
	 * ]);
	 * ```
	 */
	bulkSet(entries: Array<{ key: string; val: T }>): void {
		this.doc.transact(() => {
			for (const { key, val } of entries) {
				const entry: YKeyValueLwwEntry<T> = {
					key,
					val,
					ts: this.getTimestamp(),
				};

				this.pending.set(key, entry);
				this.pendingDeletes.delete(key);
				this.yarray.push([entry]);
			}
		});
	}

	/**
	 * Delete a key. No-op if key doesn't exist.
	 *
	 * Scans the Y.Array to find and remove the entry — O(n) per call.
	 * For bulk deletions (1K+ keys), use {@link bulkDelete} which does
	 * one scan for all keys instead of one scan per key.
	 *
	 * Removes from `pending` immediately and triggers Y.Array deletion.
	 * The observer will update `map` when the deletion is processed.
	 * Adds the key to `pendingDeletes` so that `get()`, `has()`, and
	 * `entries()` return correct results before the observer fires.
	 */
	delete(key: string): void {
		// Remove from pending if present. If it was pending, the entry is in the
		// Y.Array (set() pushes immediately) but not yet in map (observer deferred).
		const wasPending = this.pending.delete(key);

		// If already pending delete, no-op
		if (this.pendingDeletes.has(key)) return;

		if (!this._map.has(key) && !wasPending) return;

		this.pendingDeletes.add(key);
		this.deleteEntryByKey(key);
		// DO NOT update this.map here - observer is the sole writer to map
	}

	/**
	 * Delete many keys in one scan plus one batched transaction.
	 *
	 * Unlike calling {@link delete} in a loop (which scans the array per call —
	 * O(n²) for N deletions), this collects all matching entry indices in a single
	 * `toArray()` scan, then deletes them right-to-left so indices stay stable.
	 *
	 * ## Why right-to-left?
	 *
	 * Deleting at index 9000 doesn't change the position of index 50. By processing
	 * indices in descending order, all pre-computed indices remain valid throughout
	 * the batch. No re-scanning needed.
	 *
	 * @example
	 * ```typescript
	 * ykv.bulkDelete(['key-1', 'key-2', 'key-3']);
	 * ```
	 */
	bulkDelete(keys: string[]): void {
		const keySet = new Set(keys);
		const entries = this.yarray.toArray();
		const indicesToDelete: number[] = [];

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (!entry || !keySet.has(entry.key)) continue;

			indicesToDelete.push(i);
			this.pendingDeletes.add(entry.key);
			this.pending.delete(entry.key);
		}

		if (indicesToDelete.length === 0) return;

		this.doc.transact(() => {
			for (let i = indicesToDelete.length - 1; i >= 0; i--) {
				const index = indicesToDelete[i];
				if (index !== undefined) this.yarray.delete(index);
			}
		});
	}

	/**
	 * Get value by key. O(1) via in-memory Map.
	 *
	 * Checks `pending` first (for values written but not yet processed by observer),
	 * then falls back to `map` (authoritative cache updated by observer).
	 */
	get(key: string): T | undefined {
		// Check pending deletes first (deleted but observer hasn't fired yet)
		if (this.pendingDeletes.has(key)) return undefined;

		// Check pending first (written by set() but observer hasn't fired yet)
		const pending = this.pending.get(key);
		if (pending) return pending.val;

		return this._map.get(key)?.val;
	}

	/**
	 * Check if key exists. O(1) via in-memory Map.
	 *
	 * Checks both `pending` and `map` to handle values written but not yet
	 * processed by the observer.
	 */
	has(key: string): boolean {
		if (this.pendingDeletes.has(key)) return false;
		return this.pending.has(key) || this._map.has(key);
	}

	/**
	 * Iterate over all entries (both pending and confirmed).
	 *
	 * Yields entries from both `pending` and `map`, with pending taking
	 * precedence for keys that exist in both. This is necessary for code
	 * that needs to iterate over all current values inside a batch.
	 *
	 * @example
	 * ```typescript
	 * for (const [key, entry] of kv.entries()) {
	 *   console.log(key, entry.val);
	 * }
	 * ```
	 */
	*entries(): IterableIterator<[string, YKeyValueLwwEntry<T>]> {
		// Track keys we've already yielded from pending
		const yieldedKeys = new Set<string>();

		// Yield pending entries first (they take precedence)
		for (const [key, entry] of this.pending) {
			yieldedKeys.add(key);
			yield [key, entry];
		}

		// Yield map entries that weren't in pending and aren't pending delete
		for (const [key, entry] of this._map) {
			if (!yieldedKeys.has(key) && !this.pendingDeletes.has(key)) {
				yield [key, entry];
			}
		}
	}

	/** Register an observer. Called when keys are added, updated, or deleted. */
	observe(handler: YKeyValueLwwChangeHandler<T>): void {
		this.changeHandlers.add(handler);
	}

	/** Unregister an observer. */
	unobserve(handler: YKeyValueLwwChangeHandler<T>): void {
		this.changeHandlers.delete(handler);
	}

	/**
	 * Unregister the Y.Array observer. Call when this wrapper is no longer needed
	 * but the underlying Y.Array continues to exist.
	 */
	dispose(): void {
		this.yarray.unobserve(this._observer);
	}
}
