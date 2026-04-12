# Workspace Performance Fix & Dead Code Cleanup

**Date**: 2026-04-12
**Status**: Draft
**Author**: AI-assisted (from deep audit session)

## Overview

Fix the one real performance bottleneck in the workspace API (O(n²) bulk updates), remove dead code identified during audit, and consolidate an over-split module. Seven changes total, ordered by dependency and risk.

## Motivation

### Current State

The workspace package ships ~91 source files. A structural audit revealed:

1. **One algorithmic bottleneck**: `deleteEntryByKey()` does `toArray().findIndex()` on every update/delete — O(n) per call. Bulk updating 10K existing rows takes 560ms where it should take ~60ms.

2. **Three dead modules** (0 external callers): `ingest/` (7 files), `extensions/materializer/sqlite/` (4 files), `extensions/persistence/sqlite.ts` (1 file).

3. **One dead utility**: `shared/snakify.ts` — only imported by the dead `ingest/` module.

4. **One over-split module**: `shared/standard-schema/` is 3 files for 1 type + 1 function.

5. **No chunked insertion API** for 25K+ row imports, causing UI freezes.

### Desired State

- Bulk update of 10K rows: ~60ms (from 560ms)
- Package has no dead code shipping to consumers
- `shared/standard-schema/` is a single file
- Import operations > 100ms have a progress callback option

## Research Findings

### O(n²) Bulk Update — Root Cause

Benchmarked via `benchmark.test.ts` (9 new tests committed in this session):

```
  10,000 rows:
    Bulk INSERT (new keys):    111.9ms   (11.2µs/row)   ← O(n)
    Bulk UPDATE (existing):    560.1ms   (56.0µs/row)   ← O(n²)
    Single-row autosave:       138.4µs                   ← O(n), acceptable
```

The asymmetry comes from `set()` calling `deleteEntryByKey()` for existing keys:

```typescript
// y-keyvalue-lww.ts, line ~468
private deleteEntryByKey(key: string): void {
    const index = this.yarray.toArray().findIndex((e) => e.key === key);
    //            ^^^^^^^^^^^^^^^^^ O(n) copy + O(n) scan
    if (index !== -1) this.yarray.delete(index);
}
```

The observer already handles duplicate-key resolution during sync conflicts — it's the same dedup logic needed here.

### Storage Edge Cases — Confirmed Non-Issue

Benchmarked 7 storage scenarios at 10K scale:

| Scenario | Result |
|---|---|
| 10K rows, each edited 20x | 1.035x baseline (3.5% overhead) |
| 10K rows added, edited 3x, deleted all | 36 bytes residual |
| 5K permanent + 10 cycles churning 5K | +22 bytes total |
| 500 edits to 1 row among 1K | 0.0 bytes growth |
| 10K rows from 100 different clients | +2.1 KB (~22 bytes/client) |

Storage is not a concern with `gc: true`.

### Dead Code — Caller Counts

| Module | Files | External callers | Last meaningful use |
|---|---|---|---|
| `ingest/` | 7 | 0 | Internal script only |
| `materializer/sqlite/` | 4 | 0 | Never imported by an app |
| `persistence/sqlite.ts` | 1 | 0 | Never imported by an app |
| `shared/snakify.ts` | 1 | 0 (only by dead `ingest/`) | Dead dependency |

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Fix O(n²) update | Defer delete to observer | Observer already handles this for sync conflicts; reuse existing dedup |
| Build entry→index map | In observer, from single `toArray()` | O(n) build once + O(1) per lookup vs O(n) per `indexOf` call |
| Keep `delete()` as O(n) | Accepted | `delete()` is rare (benchmarks confirm), not worth the complexity |
| Remove ingest/ | Delete, don't extract | Zero consumers, no evidence anyone wants it as a package |
| Remove materializer/sqlite/ | Delete | Zero consumers; can be rebuilt if needed |
| Remove persistence/sqlite.ts | Delete | Zero consumers; indexeddb covers all current apps |
| Merge standard-schema/ | Single file | 3 files for 2 exports is unnecessary indirection |
| Bulk import API | Defer to after perf fix | Depends on the perf fix; design the API after verifying the new numbers |

## Architecture

### O(n²) Fix — Before and After

```
BEFORE (current):
─────────────────
set('foo', newVal)                    // existing key
  ├── deleteEntryByKey('foo')         // O(n): toArray().findIndex()
  │     ├── yarray.toArray()          // O(n) copy
  │     ├── .findIndex(...)           // O(n) scan
  │     └── yarray.delete(idx)        // O(1)
  └── yarray.push([entry])           // O(1)
                                      // Total: O(n) per set

For 10K updates: 10K × O(n) = O(n²) = 560ms


AFTER (proposed):
─────────────────
set('foo', newVal)                    // existing key
  └── yarray.push([entry])           // O(1) — just push, no delete
                                      // Observer deduplicates in batch

Observer fires (once per transaction):
  ├── Build entryIndexMap from        // O(n) — one toArray() call
  │   single toArray() snapshot
  ├── For each conflict:              // O(1) per lookup via Map
  │     entryIndexMap.get(existing)
  └── Batch delete all losers          // O(k) for k conflicts
                                      // Total: O(n + k) per transaction

For 10K updates in one transaction: O(n + 10K) = O(n) ≈ ~60ms
```

### Pending/Read Correctness During Dedup Window

Between `set()` and observer firing, the Y.Array has duplicate entries:

```
Y.Array: [..., old-foo-entry, ..., new-foo-entry]

Reads are correct because:
  get('foo')    → checks pending first → returns new value  ✓
  has('foo')    → checks pending first → true               ✓
  entries()     → yields pending first, skips map dupes     ✓

This is the SAME state as during multi-device sync conflicts,
which the observer already handles correctly.
```

## Implementation Plan

### Wave 1: Fix O(n²) `deleteEntryByKey` (highest impact)

- [ ] **1.1** Read `y-keyvalue-lww.ts` fully — understand `set()`, `delete()`, observer, `pending` mechanism
- [ ] **1.2** Modify `set()`: remove the `deleteEntryByKey()` call for existing keys — just push the new entry
- [ ] **1.3** In the observer's conflict resolution path, replace `getAllEntries().indexOf(existing)` with an entry→index `Map`:
  ```typescript
  let entryIndexMap: Map<YKeyValueLwwEntry<T>, number> | null = null;
  const getEntryIndex = (entry: YKeyValueLwwEntry<T>): number => {
      if (!entryIndexMap) {
          const entries = getAllEntries();
          entryIndexMap = new Map();
          for (let i = 0; i < entries.length; i++) {
              entryIndexMap.set(entries[i]!, i);
          }
      }
      return entryIndexMap.get(entry) ?? -1;
  };
  ```
- [ ] **1.4** Run existing tests: `bun test packages/workspace/src/shared/y-keyvalue/`
- [ ] **1.5** Run benchmark tests and compare bulk update timing (target: ~60ms for 10K vs current 560ms)
- [ ] **1.6** Run full workspace test suite: `bun test packages/workspace/`
- [ ] **1.7** Stage and commit

### Wave 2: Remove dead code — `ingest/`

- [ ] **2.1** Delete `src/ingest/` directory (7 source files + tests)
- [ ] **2.2** Delete `scripts/reddit-import-test.ts` if it exists
- [ ] **2.3** Remove `ingest` and `ingest/reddit` subpath exports from `package.json`
- [ ] **2.4** Verify no imports break: `bun test`
- [ ] **2.5** Stage and commit

### Wave 3: Remove dead code — `shared/snakify.ts`

- [ ] **3.1** Delete `src/shared/snakify.ts`
- [ ] **3.2** Remove `@sindresorhus/slugify` from package.json dependencies if no other consumer
- [ ] **3.3** `bun install` to update lockfile
- [ ] **3.4** Stage and commit

### Wave 4: Remove dead code — `materializer/sqlite/`

- [ ] **4.1** Delete `src/extensions/materializer/sqlite/` directory (4 source files + tests)
- [ ] **4.2** Remove `extensions/materializer/sqlite` subpath export from `package.json`
- [ ] **4.3** Remove `drizzle-orm` and `@electric-sql/pglite` from dependencies if only used here
- [ ] **4.4** Verify no imports break: `bun test`
- [ ] **4.5** Stage and commit

### Wave 5: Remove dead code — `persistence/sqlite.ts`

- [ ] **5.1** Delete `src/extensions/persistence/sqlite.ts` and its test file
- [ ] **5.2** Remove `extensions/persistence/sqlite` subpath export from `package.json`
- [ ] **5.3** Verify no imports break
- [ ] **5.4** Stage and commit

### Wave 6: Merge `shared/standard-schema/` into single file

- [ ] **6.1** Read current 3 files: `index.ts`, `types.ts`, `to-json-schema.ts`
- [ ] **6.2** Merge into single `src/shared/standard-schema.ts` with both the `CombinedStandardSchema` type and `standardSchemaToJsonSchema` function
- [ ] **6.3** Update all internal imports (grep for `shared/standard-schema`)
- [ ] **6.4** Remove the `shared/standard-schema/` directory
- [ ] **6.5** Update any package.json subpath export if one exists
- [ ] **6.6** Run tests, verify no breaks
- [ ] **6.7** Stage and commit

### Wave 7: Bulk import progress-bar API

- [ ] **7.1** Add a `bulkSet` method to `TableHelper` that chunks insertions and yields to the event loop:
  ```typescript
  async bulkSet(rows: TRow[], options?: {
      chunkSize?: number;       // default: 1000
      onProgress?: (percent: number) => void;
  }): Promise<void>;
  ```
- [ ] **7.2** Implement in `create-table.ts` — chunk by `chunkSize`, insert each chunk synchronously, call `onProgress`, then `await new Promise(resolve => setTimeout(resolve, 0))` to yield
- [ ] **7.3** Add the type to `TableHelper` in `types.ts`
- [ ] **7.4** Write tests: verify all rows inserted, verify progress callback fires, verify chunking behavior
- [ ] **7.5** Run benchmarks to confirm each chunk stays under 16ms frame budget at default chunk size
- [ ] **7.6** Stage and commit

## Edge Cases

### Wave 1: `set()` then `delete()` in same transaction

1. `set('foo', newVal)` pushes without deleting old
2. `delete('foo')` calls `deleteEntryByKey('foo')` — but which entry does it find?
3. It could find the OLD entry (correct) or the NEW entry (wrong — it was just pushed)
4. **Mitigation**: `delete()` should check `pending` and remove the pending entry too. The observer will clean up the old array entry.

### Wave 1: Multiple `set()` for same key in one transaction

1. `set('foo', val1)` pushes entry1
2. `set('foo', val2)` pushes entry2
3. Y.Array now has: old-foo, entry1, entry2
4. Observer sees 3 entries for 'foo', keeps highest-ts (entry2), batch-deletes the other 2
5. **This already works** — the observer's conflict resolution handles arbitrary duplicates.

### Wave 4: Drizzle dependency removal

`drizzle-orm` was re-exported from the root barrel (now removed). But it might still be a dependency for the markdown materializer or other internal code. Must verify before removing from package.json.

### Wave 6: Standard-schema subpath export

If `@epicenter/workspace/shared/standard-schema` is a package.json subpath export, removing the directory would break the export. Must check and update package.json.

## Open Questions

1. **Should `delete()` also defer to the observer?**
   - Currently `delete()` still does the O(n) `deleteEntryByKey` scan
   - Option A: Leave as-is (delete is rare, benchmarks show 29.5µs per delete at 10K)
   - Option B: Defer to observer (same pattern as `set()` fix)
   - **Recommendation**: Leave as-is (Option A). Delete is infrequent. Optimize only if benchmarks show a problem.

2. **Should removed dead code go to an archive branch?**
   - Option A: Just delete — git history preserves it
   - Option B: Create `archive/ingest`, `archive/materializer-sqlite` branches
   - **Recommendation**: Just delete (Option A). Git blame and `git log --all -- path` find anything.

3. **Should `bulkSet` wrap in `ydoc.transact()`?**
   - Wrapping the whole bulk in one transaction defers observer until the end — better performance but larger memory spike
   - Wrapping each chunk in its own transaction fires observer per chunk — more incremental but more overhead
   - **Recommendation**: One transaction per chunk. Matches the progress-bar pattern (state updates per chunk) and keeps memory bounded.

## Success Criteria

- [ ] Bulk update of 10K existing rows completes in < 150ms (benchmark test)
- [ ] All existing tests pass after each wave
- [ ] No `@epicenter/workspace/ingest` subpath exists in package.json
- [ ] No `@epicenter/workspace/extensions/materializer/sqlite` subpath exists
- [ ] No `@epicenter/workspace/extensions/persistence/sqlite` subpath exists
- [ ] `shared/standard-schema/` directory no longer exists; single file replaces it
- [ ] `bulkSet` method exists on `TableHelper` with `onProgress` callback
- [ ] `snakify.ts` no longer exists; `@sindresorhus/slugify` removed if unused elsewhere

## References

- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww.ts` — the O(n²) bottleneck lives here
- `packages/workspace/src/workspace/create-table.ts` — `TableHelper` implementation, where `bulkSet` goes
- `packages/workspace/src/workspace/types.ts` — `TableHelper` type definition
- `packages/workspace/src/workspace/benchmark.test.ts` — existing benchmarks to verify against
- `packages/workspace/src/ingest/` — dead module to remove
- `packages/workspace/src/extensions/materializer/sqlite/` — dead module to remove
- `packages/workspace/src/extensions/persistence/sqlite.ts` — dead file to remove
- `packages/workspace/src/shared/snakify.ts` — dead utility to remove
- `packages/workspace/src/shared/standard-schema/` — 3 files to merge into 1
- `packages/workspace/package.json` — subpath exports to clean up
