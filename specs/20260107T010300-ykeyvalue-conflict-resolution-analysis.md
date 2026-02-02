# YKeyValue Conflict Resolution Analysis

**Status**: ANALYSIS COMPLETE
**Follow-up**: See `20260108T084500-ymap-native-storage-architecture.md` for final decision

> **Outcome**: After this analysis and subsequent benchmarking, we decided to use native Y.Map of
> Y.Maps with epoch-based compaction instead of implementing LWW timestamps. The unpredictable
> conflict resolution affects <1% of edits (same-cell offline conflicts are rare), and the epoch
> system provides free compaction without custom CRDT code.

## Overview

This spec documents the conflict resolution behavior of YKeyValue and evaluates alternatives for offline-first editing scenarios.

## Current Implementation: Positional (Rightmost Wins)

Our YKeyValue implementation (`packages/epicenter/src/core/utils/y-keyvalue.ts`) uses **positional conflict resolution**:

```typescript
// When two clients set the same key concurrently:
// Client A: array.push({key:'x', val:'A'})
// Client B: array.push({key:'x', val:'B'})
//
// After Yjs CRDT merge, array contains both:
//   [{key:'x', val:'A'}, {key:'x', val:'B'}]  // or reversed
//
// Cleanup scans right-to-left, keeps rightmost:
//   [{key:'x', val:'B'}]  // B wins (was rightmost)
```

**Key point**: The "winner" depends on **Yjs sync order**, NOT chronological order. This is unpredictable from the user's perspective.

## The Problem: Offline Sync Scenarios

### Scenario 1: Concurrent Updates

```
Client A (offline at 10:00am): sets key "doc" to "version-A"
Client B (offline at 10:05am): sets key "doc" to "version-B"

Both reconnect simultaneously.

Expected (intuitive): B wins (later edit)
Actual: Unpredictable (depends on Yjs merge order)
```

### Scenario 2: Delete vs Update Race

```
Client A (offline): deletes key "doc"
Client B (offline): updates key "doc" to new value

Both reconnect.

Current behavior:
- If A's delete happens after B's entry is in the array, doc is deleted
- If B's entry ends up rightmost, doc survives

No timestamp comparison; purely positional.
```

### Scenario 3: Schema Column Changes (Epicenter-specific)

User removes a column from schema. Rows still have the old property in YJS storage.

```typescript
// Before: { id: '1', title: 'Hello', oldColumn: 'data' }
// Schema changes: oldColumn removed
// Row still has: { id: '1', title: 'Hello', oldColumn: 'data' }
```

**Current handling**:

- Extra properties are ignored during validation (arktype allows unknown keys by default)
- Properties persist until the row is re-upserted without them
- No automatic cleanup of stale properties

**Question**: Should we actively delete orphaned properties?

- Pro: Cleaner storage
- Con: If schema reverts, data is lost

## Alternative: y-lwwmap (Last-Write-Wins)

[rozek/y-lwwmap](https://github.com/rozek/y-lwwmap) uses timestamps for conflict resolution.

### How It Works

```typescript
// Entry structure
type Entry<T> = {
	Key: string;
	Value?: T; // Optional = tombstone when missing
	Timestamp: number;
};

// Synthetic timestamps (Lamport-like)
const TimestampFactor = 3000; // ~3000 ops per ms headroom
timestamp = Math.max(lastTimestamp + 1, Date.now() * TimestampFactor);
```

### What is blueimp-md5 for?

When two entries have **identical timestamps** (rare but possible with clock sync), LWWMap needs a deterministic tiebreaker:

```typescript
// If timestamps collide, compare MD5 hashes of values
// Higher hash wins (deterministic across all clients)
_ChangesCollide(first, second): boolean {
  return (
    first.Timestamp > second.Timestamp ||
    (first.Timestamp === second.Timestamp &&
     first.Value !== second.Value &&
     md5(JSON.stringify(first.Value)) > md5(JSON.stringify(second.Value)))
  );
}
```

This ensures **all clients converge to the same state** even in edge cases.

### Tombstone Retention

Deletions are stored as entries without `Value`:

```typescript
{ Key: 'foo', Timestamp: 123456789 }  // No Value = deleted
```

Tombstones are kept for `RetentionPeriod` (default 30 days), then purged. This allows:

- Offline client deletes at 10am
- Another client updates at 10:05am
- On sync, timestamps are compared; later action wins

## Comparison

| Aspect              | YKeyValue (current)  | LWWMap               | YKeyValue + timestamps |
| ------------------- | -------------------- | -------------------- | ---------------------- |
| Conflict resolution | Positional           | Timestamp            | Timestamp              |
| Predictability      | Sync-order dependent | Chronological        | Chronological          |
| Deletion handling   | Immediate            | Tombstones (30 days) | Immediate              |
| Storage per entry   | ~N bytes             | ~N+8+tombstones      | ~N+8 bytes             |
| Dependencies        | None                 | blueimp-md5          | None                   |
| Code complexity     | ~180 lines           | ~450 lines           | ~220 lines             |

## Storage Analysis: Is 8 Bytes Per Entry Worth It?

### Current Entry Size

```typescript
{ key: string, val: T }
```

For a typical row with ID "abc123" and some data:

- key overhead: ~10-20 bytes
- val: depends on data (100-1000+ bytes typical)

### With Timestamp

```typescript
{ key: string, val: T, timestamp: number }
```

- Additional: 8 bytes for number (stored as float64 in JSON)
- Percentage increase: 0.8-8% depending on val size

### Verdict

For an offline-first editor where **predictable conflict resolution matters**, 8 bytes per entry is negligible. The storage savings from YKeyValue over Y.Map (1935x) dwarf this addition.

## Recommendation: Timestamp-Enhanced YKeyValue

A middle ground that gives LWW semantics without tombstone overhead:

### Changes Required

1. **Entry structure**: Add timestamp field

```typescript
type Entry<T> = { key: string; val: T; timestamp: number };
```

2. **Set operation**: Include timestamp

```typescript
set(key: string, val: T): void {
  const timestamp = this.getNextTimestamp();
  const entry = { key, val, timestamp };
  // ... rest unchanged
}
```

3. **Conflict resolution in observer**: Compare timestamps, not positions

```typescript
// Current: addedVals.get(currVal.key) === currVal (identity check)
// Enhanced: Compare timestamps when resolving duplicates
if (existing && existing.timestamp > currVal.timestamp) {
	// Existing is newer, remove this entry
	itemsToRemove.add(currVal.key);
	continue;
}
```

4. **Synthetic timestamp**: Lamport-like monotonic

```typescript
private lastTimestamp = 0;

private getNextTimestamp(): number {
  const now = Date.now();
  this.lastTimestamp = Math.max(this.lastTimestamp + 1, now);
  return this.lastTimestamp;
}
```

### What This Doesn't Solve

- **Tombstones for deletions**: A delete is still just removing the entry. If Client A deletes and Client B updates (both offline), the update "wins" because there's no tombstone to compare against.

For Epicenter's use case (deletions are rare, schema changes handle column removal), this tradeoff is acceptable.

## Questions Answered

### 1. Does YKeyValue actually exhibit the sync-order problem?

**YES, confirmed by tests.** See `packages/epicenter/src/core/utils/y-keyvalue.test.ts`

Test results:

```
Concurrent update winners: [
  "value-from-2-iteration-0",
  "value-from-2-iteration-1",
  "value-from-2-iteration-2",
  "value-from-1-iteration-3",  ← Client 1 won
  "value-from-1-iteration-4",  ← Client 1 won
  "value-from-2-iteration-5",
  ...
]
```

The winner varies between iterations, proving sync order is unpredictable.

### 2. Is timestamp-based LWW worth implementing?

**Yes, for offline-first scenarios.** 8 bytes per entry is negligible overhead.

### 3. Should we handle schema column deletions?

**No active cleanup needed.** Orphaned properties persist silently but don't cause validation failures (arktype allows unknown keys). Properties are cleaned up when the row is re-upserted.

### 4. Deletion Analysis

All deletions in the codebase are **explicit user actions**:

- `table-helper.ts:433` - `delete(id)`
- `table-helper.ts:450` - `deleteMany()`
- `table-helper.ts:484` - `clear()`
- `kv-helper.ts:221` - `reset()` (only when no default AND not nullable)
- `kv/core.ts:61` - `clearAll()`

**No automatic or implicit deletions exist.**

### 5. "Soft Delete" Alternative

Could replace hard deletes with `set(key, { _deleted: true, _deletedAt: timestamp })`:

- Pro: Deletion becomes an update, uses same timestamp comparison
- Con: "Deleted" entries persist forever unless GC added

**Recommendation**: Not needed since deletions are rare. Accept delete-vs-update race unpredictability.

## References

- [rozek/y-lwwmap](https://github.com/rozek/y-lwwmap): Timestamp-based alternative
- [yjs/y-utility](https://github.com/yjs/y-utility): Original YKeyValue implementation
- [Yjs issue 520](https://github.com/yjs/yjs/issues/520): Conflict resolution unpredictability discussion
- [Lamport timestamps](https://lamport.azurewebsites.net/pubs/time-clocks.pdf): Theoretical foundation

## Related Articles

- [docs/articles/ykeyvalue-meta-data-structure.md](../docs/articles/ykeyvalue-meta-data-structure.md)
- [docs/articles/ykeyvalue-migration-storage-gains.md](../docs/articles/ykeyvalue-migration-storage-gains.md)
- [docs/articles/y-lwwmap-last-write-wins-alternative.md](../docs/articles/y-lwwmap-last-write-wins-alternative.md)
