# YKeyValue LWW Timestamps Implementation

**Status**: IMPLEMENTED as `YKeyValueLww` (see `20260127T120000-ykeyvalue-dual-implementation.md`)

> **Update 2026-01-27**: This spec has been implemented as a separate class `YKeyValueLww` in
> `y-keyvalue-lww.ts`. The original `YKeyValue` (positional conflict resolution) is preserved
> for backwards compatibility. See the dual-implementation spec for guidance on when to use each.
>
> The implementation below has been simplified: we store only `ts` (timestamp), not `by` (clientID),
> because the clientID tiebreaker is only needed when timestamps are exactly equal, which is rare
> enough that falling back to positional ordering (Yjs's native clientID-based ordering) suffices.

## Summary

Add Last-Write-Wins (LWW) timestamps to YKeyValue so chronologically later edits always win during conflict resolution.

## Problem

Current YKeyValue uses "rightmost wins" positional conflict resolution:

- Winner depends on Yjs internal ordering (client IDs), not time
- Earlier edits can overwrite later ones
- Users expect "my later edit should stick"

Test evidence: editing 100ms later still loses sometimes due to random client ID ordering.

## Solution: Simplified LWW with Incremental Winner Tracking

### Design Principles

1. **One record type** (not three) - optional `val` indicates tombstone
2. **Incremental winner tracking** - update map immediately, not during compaction
3. **Compaction is cleanup only** - correctness doesn't depend on it
4. **Closures, not classes** - functional style
5. **No backwards compatibility** - clean break

### Record Structure

```typescript
type KvRecord<T> = {
	key: string;
	val?: T; // Missing = tombstone (deleted)
	ts: number; // Timestamp (monotonic per client)
	by: number; // Client ID (tie-breaker)
};
```

**Why optional `val` for tombstones?**

- Unambiguous: `'val' in record` is reliable
- Space-efficient: no wasted bytes
- Avoids collision with user `null` values
- Matches y-lwwmap pattern

### Winner Selection (Deterministic)

```typescript
function isNewer<T>(a: KvRecord<T>, b: KvRecord<T>): boolean {
	if (a.ts !== b.ts) return a.ts > b.ts;
	return a.by > b.by;
}
```

All peers use the same comparison, so they converge to the same winner.

### Timestamp Generation

```typescript
function createMonotonicClock() {
	let lastTs = 0;

	return {
		next(): number {
			const now = Date.now();
			lastTs = Math.max(now, lastTs + 1);
			return lastTs;
		},

		// Sync with observed remote timestamps to prevent being dominated
		observe(remoteTs: number): void {
			lastTs = Math.max(lastTs, remoteTs);
		},
	};
}
```

The `observe()` call ensures that after seeing a remote timestamp, our next write will beat it.

## Implementation

### Core Structure

```typescript
type ChangeEvent<T> =
	| { action: 'add'; newValue: T }
	| { action: 'update'; oldValue: T; newValue: T }
	| { action: 'delete'; oldValue: T };

type ChangeHandler<T> = (
	changes: Map<string, ChangeEvent<T>>,
	transaction: Y.Transaction | null,
) => void;

function createYKeyValue<T>(yarray: Y.Array<KvRecord<T>>) {
	const doc = yarray.doc!;
	const clock = createMonotonicClock();

	// Winner tracking (includes tombstones for comparison)
	const winners = new Map<string, KvRecord<T>>();

	// Public map (excludes tombstones - deleted keys not present)
	const map = new Map<string, T>();

	// Change handlers
	const handlers = new Set<ChangeHandler<T>>();

	// ... methods below
}
```

### Processing Records (Incremental)

When any record arrives (local or remote), immediately update winners and emit events:

```typescript
const processRecord = (
	record: KvRecord<T>,
	transaction: Y.Transaction | null,
): void => {
	// Sync our clock with remote timestamps
	clock.observe(record.ts);

	const existing = winners.get(record.key);

	// Check if this record wins
	if (existing && !isNewer(record, existing)) {
		return; // Loser, ignore
	}

	// This record wins - determine event type
	const hadValue = existing !== undefined && 'val' in existing;
	const hasValue = 'val' in record;

	let event: ChangeEvent<T> | null = null;

	if (!hadValue && hasValue) {
		// Add: nothing → value
		event = { action: 'add', newValue: record.val! };
		map.set(record.key, record.val!);
	} else if (hadValue && hasValue) {
		// Update: value → value
		event = {
			action: 'update',
			oldValue: existing!.val!,
			newValue: record.val!,
		};
		map.set(record.key, record.val!);
	} else if (hadValue && !hasValue) {
		// Delete: value → tombstone
		event = { action: 'delete', oldValue: existing!.val! };
		map.delete(record.key);
	}
	// tombstone → tombstone: no event, no map change

	winners.set(record.key, record);

	// Emit event
	if (event && handlers.size > 0) {
		const changes = new Map([[record.key, event]]);
		for (const handler of handlers) {
			handler(changes, transaction);
		}
	}
};
```

### Initialization

Process existing records on construction:

```typescript
// Initialize from existing array
for (const record of yarray.toArray()) {
	processRecord(record, null);
}
```

### Observer (Watch for Changes)

```typescript
yarray.observe((event, transaction) => {
	// Ignore compaction transactions
	if (transaction.origin === 'kv.compact') return;

	// Process newly added records
	for (const item of event.changes.added) {
		for (const record of item.content.getContent() as KvRecord<T>[]) {
			processRecord(record, transaction);
		}
	}
});
```

### Write Operations

```typescript
const set = (key: string, val: T): void => {
	const record: KvRecord<T> = { key, val, ts: clock.next(), by: doc.clientID };
	yarray.push([record]);
	// Observer will call processRecord
};

const del = (key: string): void => {
	const record: KvRecord<T> = { key, ts: clock.next(), by: doc.clientID };
	yarray.push([record]);
	// Observer will call processRecord
};
```

### Compaction (Cleanup Only)

Compaction removes dominated records. It does NOT affect correctness - just reduces storage.

```typescript
let compactTimer: ReturnType<typeof setTimeout> | null = null;
let isCompacting = false;

const compact = (): void => {
	if (isCompacting) return;
	isCompacting = true;

	try {
		const dominated: number[] = [];
		const arr = yarray.toArray();

		for (let i = 0; i < arr.length; i++) {
			const record = arr[i];
			const winner = winners.get(record.key);

			// Keep the winner, mark losers for deletion
			if (winner && isNewer(winner, record)) {
				dominated.push(i);
			}
		}

		if (dominated.length > 0) {
			doc.transact(() => {
				// Delete in reverse order to preserve indices
				for (let i = dominated.length - 1; i >= 0; i--) {
					yarray.delete(dominated[i], 1);
				}
			}, 'kv.compact');
		}
	} finally {
		isCompacting = false;
	}
};

const scheduleCompact = (): void => {
	if (compactTimer) return;
	compactTimer = setTimeout(() => {
		compactTimer = null;
		compact();
	}, 100);
};

// Trigger compaction on any changes
yarray.observeDeep(scheduleCompact);
```

### Public API

```typescript
return {
	get: (key: string): T | undefined => map.get(key),
	has: (key: string): boolean => map.has(key),
	set,
	delete: del,

	// For iteration (table reconstruction, etc.)
	get map(): Map<string, T> {
		return map;
	},

	// Change events
	on: (event: 'change', handler: ChangeHandler<T>): void => {
		if (event === 'change') handlers.add(handler);
	},
	off: (event: 'change', handler: ChangeHandler<T>): void => {
		if (event === 'change') handlers.delete(handler);
	},
};
```

## Behavior Changes

### get(key)

- Returns `undefined` if key doesn't exist OR if winner is a tombstone
- No change to return type

### has(key)

- Returns `false` if key doesn't exist OR if winner is a tombstone
- No change to return type

### set(key, val)

- Pushes new record with timestamp and clientId
- Winner determined by `(ts, by)` comparison, not position

### delete(key)

- Pushes tombstone record (no `val` field)
- Tombstone competes in LWW comparison
- Later delete beats earlier edit, later edit beats earlier delete

### map (for iteration)

- Excludes tombstones - only live values
- **Breaking change for table-helper.ts**: Already correct since it accesses `entry.val`

### Change Events

- Emitted immediately when winner changes (not batched)
- Delete events only emitted when oldValue is known
- If tombstone arrives for already-absent key: no event (idempotent)

## Clock Skew Handling

**Reality**: Modern devices with internet have synced clocks (NTP). Skew is rare.

**Protection**: The `clock.observe(remoteTs)` call ensures we can "catch up" to remote timestamps. After seeing a remote write, our next write will have a higher timestamp.

**Edge case**: If a collaborator's clock is far in the future, their writes win until the problem is fixed. This is acceptable because:

1. It's rare (requires broken VM, manual clock change, etc.)
2. It's recoverable (new writes with correct clock eventually win)
3. It's the collaborator's problem to fix their clock

## What This Does NOT Handle

1. **Causal ordering** - Uses wall clock, not logical clock. "Later" means "higher timestamp", not "causally after".

2. **Unbounded tombstone growth** - Tombstones remain until compaction. For bounded key sets (table columns, settings), this is fine.

3. **Nested value mutations** - Values are replaced wholesale. Use separate YJS types for collaborative editing within values.

## Migration

**No migration needed.** This is a breaking change:

- Old entries without `ts`/`by` will be treated as losers (ts=0, by=0)
- First write to any key with new code will win
- Document must be recreated or all entries re-written

## Testing Strategy

1. **Basic LWW**: Later timestamp always wins regardless of arrival order
2. **Tie-breaking**: Equal timestamps use clientId
3. **Tombstones**: Delete wins if later, edit wins if later
4. **Immediate consistency**: `set(k, v); get(k)` returns `v` immediately
5. **Change events**: Correct action (add/update/delete) with correct old/new values
6. **Compaction**: Losers removed, winners preserved, no data loss
7. **Convergence**: Multiple peers converge to same state

## Acceptance Criteria

1. ✅ Later timestamp always wins regardless of sync order
2. ✅ Equal timestamps use clientId as deterministic tie-breaker
3. ✅ `set(); get()` returns correct value immediately (no stale window)
4. ✅ Delete works as LWW operation (not just removal)
5. ✅ Change events fire immediately on winner change
6. ✅ All peers converge to identical state
7. ✅ Compaction removes losers without affecting correctness

## Effort Estimate

4-6 hours for implementation + tests.

## Files to Modify

1. `packages/epicenter/src/core/utils/y-keyvalue.ts` - Main implementation
2. `packages/epicenter/src/core/utils/y-keyvalue.test.ts` - Update tests
3. `packages/epicenter/src/core/tables/table-helper.ts` - Verify iteration still works (should be fine)
4. `packages/epicenter/src/core/kv/kv-helper.ts` - Verify delete semantics (should be fine)
