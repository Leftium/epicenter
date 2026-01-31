# Y.Array Tombstones Are Tiny: Why Add/Delete Cycles Don't Bloat Your Doc

**TL;DR**: Y.Array deletions create tombstones that only store metadata, not the full value. After 5 cycles of adding and deleting 1,000 rows, the Y.Doc stays at **34 bytes**.

> When you delete from Y.Array, Yjs keeps just enough metadata to know something was deleted. The actual data gets garbage collected.

Run this stress test and watch the magic:

```typescript
const ydoc = new Y.Doc();
const tables = createTables(ydoc, { posts: postDefinition });

for (let cycle = 0; cycle < 5; cycle++) {
  // Add 1,000 rows (~72KB of data)
  for (let i = 0; i < 1_000; i++) {
    tables.posts.set({ id: `id-${i}`, title: `Post ${i}`, views: i });
  }

  // Delete all 1,000 rows
  for (let i = 0; i < 1_000; i++) {
    tables.posts.delete(`id-${i}`);
  }

  console.log(`Cycle ${cycle + 1}: ${Y.encodeStateAsUpdate(ydoc).byteLength} bytes`);
}
```

Output:

```
Cycle 1: 34 bytes
Cycle 2: 34 bytes
Cycle 3: 34 bytes
Cycle 4: 34 bytes
Cycle 5: 34 bytes
```

Five thousand inserts. Five thousand deletes. 34 bytes.

This isn't a bug. Y.Array tombstones work differently than Y.Map's history retention.

## Y.Map vs Y.Array: Two Different Strategies

```
Y.Map behavior (problematic for KV stores):
┌─────────────────────────────────────────────────────┐
│ map.set('row1', data1)  → stores data1              │
│ map.set('row1', data2)  → stores data1 AND data2    │
│ map.set('row1', data3)  → stores data1, data2, data3│
│                                                     │
│ Result: 100k updates = 100k values retained         │
└─────────────────────────────────────────────────────┘

Y.Array behavior (used by YKeyValue):
┌─────────────────────────────────────────────────────┐
│ array.push(entry1)      → stores entry1             │
│ array.delete(0)         → tombstone (no data)       │
│ array.push(entry2)      → stores entry2             │
│ array.delete(0)         → tombstone (no data)       │
│                                                     │
│ Result: Only live entries consume space             │
└─────────────────────────────────────────────────────┘
```

Y.Map retains historical values because it needs them for CRDT conflict resolution. Y.Array only needs to know that position X was deleted, not what was there.

## The Numbers

| Scenario | Y.Doc Size |
|----------|------------|
| Empty doc | 34 bytes |
| After 1,000 inserts | 72 KB |
| After 1,000 inserts + 1,000 deletes | 34 bytes |
| After 5 cycles of 1,000 inserts/deletes | 34 bytes |
| 10,000 rows retained | 733 KB |

The pattern holds: live data determines size, not operation history.

## Why This Matters for Local-First Apps

Traditional databases worry about transaction logs and vacuum operations. With Y.Array-backed storage:

1. Users can create and delete freely without doc bloat
2. Undo/redo at the application level doesn't accumulate CRDT overhead
3. Temporary scratch data (drafts, staging) can be deleted cleanly

The YKeyValue pattern exploits this by using Y.Array as the backing store. Each `set()` appends a new entry and deletes the old one. Each `delete()` just removes the entry. No value retention, no unbounded growth.

```typescript
// YKeyValue under the hood
set(key, value) {
  if (this.map.has(key)) {
    this.deleteEntryByKey(key);  // Old value becomes a tiny tombstone
  }
  this.yarray.push([{ key, val: value }]);  // Only new value stored
}
```

The 34-byte floor is just the minimal Y.Doc overhead: client ID tracking and empty structure metadata. Your actual data lives and dies cleanly.
