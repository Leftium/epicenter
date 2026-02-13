# YKeyValueLww Tombstones Are Practically Free

> Add a thousand rows. Delete them all. Repeat five times. The binary is 35 bytes.

Yjs garbage collection does something surprising with our YKeyValueLww data structure: it makes deletion nearly free. Not "small overhead" free. Thirty-five-bytes-for-ten-thousand-operations free.

This matters because the Static Workspace API stores every table row through YKeyValueLww. If tombstones accumulated, users would pay a growing storage tax just for creating and deleting data. They don't.

## The Benchmark

This runs against the real Static Workspace API, not raw Yjs primitives. Schema validation, LWW timestamps, migration support: all of it is active.

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import { createTables, defineTable } from 'epicenter/static';

const events = defineTable(
	type({
		id: 'string',
		name: 'string',
		payload: 'string',
		timestamp: 'number',
	}),
);

const ydoc = new Y.Doc();
const tables = createTables(ydoc, { events });

const payload = JSON.stringify({
	userId: 'usr-001',
	action: 'click',
	target: 'button.submit',
	metadata: { page: '/dashboard', sessionId: 'sess-abc123' },
});

for (let cycle = 0; cycle < 5; cycle++) {
	// Add 1,000 events
	for (let i = 0; i < 1_000; i++) {
		tables.events.set({
			id: `evt-${i}`,
			name: `action_${i}`,
			payload,
			timestamp: Date.now(),
		});
	}

	// Delete all 1,000
	for (let i = 0; i < 1_000; i++) {
		tables.events.delete(`evt-${i}`);
	}

	const size = Y.encodeStateAsUpdate(ydoc).byteLength;
	console.log(
		`Cycle ${cycle + 1}: ${size} bytes, ${tables.events.count()} rows`,
	);
}
```

Output:

```
Cycle 1: 35 bytes, 0 rows
Cycle 2: 35 bytes, 0 rows
Cycle 3: 35 bytes, 0 rows
Cycle 4: 35 bytes, 0 rows
Cycle 5: 35 bytes, 0 rows
```

Five thousand inserts. Five thousand deletes. 35 bytes. The size doesn't grow across cycles.

For context, 1,000 events retained (before deletion) weigh about 223 KB. After deleting them all, the binary drops back to 35 bytes: a 99.98% reduction. The retained data is the only thing that costs storage.

## Why It Works

YKeyValueLww stores entries in a `Y.Array`. Each entry is `{ key, val, ts }`. When you set a key, it deletes the old entry and pushes a new one. When you delete a key, the entry is removed from the array.

The key insight is how Yjs handles array deletions. A deleted array element becomes a tombstone that only records "something existed at this position." The actual data (the key, value, and timestamp) is garbage collected. Yjs then merges adjacent tombstones into compact GC structs, so a thousand consecutive deletions collapse into a few bytes of metadata.

```
Before GC:  [tombstone][tombstone][tombstone]...[tombstone]  (1,000 tombstones)
After GC:   [gc_struct: 1000 items deleted]                  (a few bytes)
```

This is fundamentally different from Y.Map, where overwriting a key creates a tombstone that retains per-key conflict resolution metadata forever. Y.Map's storage scales with operation history. YKeyValueLww's storage scales with current data.

## The Caveat

This only works with `gc: true` (the Yjs default). If you set `gc: false` to enable version snapshots, tombstones can't be merged, and YKeyValueLww's advantage disappears. See [YKeyValue vs Y.Map: GC Is the Hidden Variable](./ykeyvalue-gc-the-hidden-variable.md) for the full breakdown.

## What This Means in Practice

Users can create and delete freely without worrying about storage bloat. Temporary data, draft rows, scratch work, event logs that get rotated: all of it cleans up after itself. The Static Workspace API inherits this property transparently because YKeyValueLww is the storage layer underneath every table.

---

**Related:**

- [Y.Array Tombstones Are Tiny](./y-array-tombstones-are-tiny.md): The raw Y.Array version of this benchmark
- [YKeyValue: The Most Interesting Meta Data Structure in Yjs](./ykeyvalue-meta-data-structure.md): How YKeyValue works under the hood
- [YKeyValue vs Y.Map: GC Is the Hidden Variable](./ykeyvalue-gc-the-hidden-variable.md): When this advantage disappears
