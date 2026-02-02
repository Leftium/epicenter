# How Epicenter Structures YJS Documents

This article explains the design decisions behind Epicenter's YJS document structure. After exploring several approaches, we settled on a **three top-level map** architecture that separates data by change frequency while presenting a unified API to developers.

For the full technical specification, see [Single Workspace Architecture](../specs/20260123T102500-single-workspace-architecture.md).

## The Final Structure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  WORKSPACE DOC (guid: "ws-123")                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  COLD ZONE (rarely changes)                                            │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                        │ │
│  │  Y.Map('definition')                # Workspace identity + all schemas │ │
│  │    ├── name: "My Blog"                                                 │ │
│  │    ├── icon: "emoji:📝"                                                │ │
│  │    ├── description: "..."                                              │ │
│  │    │                                                                   │ │
│  │    ├── tables: Y.Map                # Table definitions                │ │
│  │    │   └── {tableId}: Y.Map                                            │ │
│  │    │       ├── name: "Posts"                                           │ │
│  │    │       ├── icon: "emoji:📝"                                        │ │
│  │    │       ├── description: "..."                                      │ │
│  │    │       └── fields: Y.Map                                           │ │
│  │    │           └── {fieldId}: Field                                    │ │
│  │    │                                                                   │ │
│  │    └── kv: Y.Map                    # KV definitions                   │ │
│  │        └── {key}: Y.Map                                                │ │
│  │            ├── name: "Theme"                                           │ │
│  │            ├── icon: "emoji:🎨"                                        │ │
│  │            └── field: Field                                            │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  HOT ZONE (changes frequently)                                         │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │                                                                        │ │
│  │  Y.Map('tables')                    # Row data ONLY                    │ │
│  │    └── {tableId}: Y.Map             # This IS the rows map             │ │
│  │        └── {rowId}: Y.Map           # Row                              │ │
│  │            └── {fieldId}: value     # Cell  ←─── HOTTEST PATH          │ │
│  │                                                                        │ │
│  │  Y.Map('kv')                        # Values ONLY                      │ │
│  │    └── {key}: value                 # Just the value                   │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## The Core Insight: Change Frequency Matters

Not all data changes at the same rate:

```
Workspace name             ~1/month     ░░░░░░░░░░
Table schema (fields)      ~1/week      ██░░░░░░░░
KV values (settings)       ~10/day      ████░░░░░░
Row add/remove             ~100/day     ██████░░░░
Cell value changes         ~1000/day    ██████████  ← hottest
```

This observation drives everything.

## Three Maps, Three Concerns

```
Y.Map('definition')    # Cold: workspace identity + all schemas
Y.Map('tables')        # Hot: row data only
Y.Map('kv')            # Warm: setting values only
```

Each map corresponds to one concern and one output file:

| Map          | Contains                 | Output File       | Change Frequency |
| ------------ | ------------------------ | ----------------- | ---------------- |
| `definition` | Workspace meta + schemas | `definition.json` | Rarely           |
| `tables`     | Row data                 | `tables.sqlite`   | Constantly       |
| `kv`         | Setting values           | `kv.json`         | Occasionally     |

## Why Not Co-locate Everything?

We initially considered putting definitions alongside data:

```
Y.Map('tables')
  └── posts
      ├── name, icon, fields    ← definition
      └── rows                  ← data
```

This is intuitive. "A table has its schema and its data together." But it creates observation problems.

### The Observation Problem

With co-located structure, if you want to observe "just row changes":

```typescript
// You have to navigate INTO the table, past the definition
doc.getMap('tables').get('posts').get('rows').observeDeep(cb);
```

And if you observe the table itself:

```typescript
doc.getMap('tables').get('posts').observe(cb);
```

This fires for BOTH definition changes (name, icon, fields) AND structural changes to the rows map. You need to filter in your callback.

### The Separated Solution

With separated structure:

```typescript
// Definition changes (cold)
doc.getMap('definition').get('tables').get('posts').observe(cb);

// Row changes (hot) — clean, no filtering
doc.getMap('tables').get('posts').observeDeep(cb);
```

The observer attaches directly to what you care about.

## Why Three Maps, Not Two or Four?

We considered several options:

### Option: Two Maps (definition + data)

```
Y.Map('definition')   # schemas
Y.Map('data')         # tables + kv values together
```

Problem: Tables and KV have different access patterns. Tables are maps of maps (rows). KV is a flat map of values. Mixing them complicates observation.

### Option: Four Maps (meta + tableSchemas + tables + kv)

```
Y.Map('meta')              # workspace identity
Y.Map('tableDefinitions')  # table schemas
Y.Map('tables')            # row data
Y.Map('kv')                # kv definitions + values
```

Problem: More top-level maps means more things to coordinate. Workspace meta and table schemas almost always change together conceptually. Separating them adds complexity without benefit.

### Option: Five Maps (fully granular)

```
Y.Map('meta')
Y.Map('tableDefinitions')
Y.Map('kvDefinitions')
Y.Map('tables')
Y.Map('kv')
```

Problem: KV definitions rarely change independently of workspace-level decisions. This is over-engineered.

### The Sweet Spot: Three Maps

```
Y.Map('definition')   # workspace meta + all schemas (cold)
Y.Map('tables')       # row data (hot)
Y.Map('kv')           # values (warm)
```

This maps cleanly to:

- Three output files
- Three change frequency zones
- Three distinct concerns

## The API Hides the Separation

Despite the internal separation, developers see a unified interface:

```typescript
const posts = workspace.tables.get('posts');

// These read from definition.tables.posts (cold)
posts.name;
posts.icon;
posts.fields.get('title');

// These read/write from tables.posts (hot)
posts.upsert({ id: '1', title: 'Hello' });
posts.get({ id: '1' });
posts.observeRows(() => syncToSqlite());
```

The developer thinks: "I have a table, it has properties and data."
The implementation knows: "Properties come from here, data comes from there."

## Benefits of This Approach

### 1. Clean Observation Boundaries

```typescript
// Only fires for row/cell changes, never for schema changes
posts.observeRows(() => { ... });

// Only fires for field changes, never for row changes
posts.fields.observe(() => { ... });
```

No filtering. Observers attach to exactly what they need.

### 2. Different Sync Strategies

```typescript
// Cold zone: sync every 5 seconds
definition.observeDeep(() => debouncedSync(5000));

// Hot zone: sync every 100ms
tables.observeDeep(() => debouncedSync(100));
```

Hot data syncs fast. Cold data syncs slow. Each zone gets appropriate treatment.

### 3. Easy Multi-Doc Migration

If you later need to split into multiple Y.Docs:

```
WORKSPACE DOC (light)     TABLE DOC (heavy)
├── definition            └── rows
```

The `definition` map is already the right shape. Just move `tables.{id}` to its own doc.

### 4. File Output Alignment

```
Y.Map('definition')  →  definition.json
Y.Map('tables')      →  tables.sqlite
Y.Map('kv')          →  kv.json
```

Each map materializes to one file. No complex extraction logic.

## Trade-offs We Accepted

### Atomic Cross-Tree Operations

Adding a field and backfilling rows requires touching two trees:

```typescript
doc.transact(() => {
	// Definition tree
	definition.get('tables').get('posts').get('fields').set('status', field);

	// Data tree
	for (const [id, row] of tables.get('posts').entries()) {
		row.set('status', 'draft');
	}
});
```

This works fine (same Y.Doc, same transaction), but you're explicitly touching two places. We decided this explicitness is actually good; it makes the operation's scope clear.

### API Bridging Complexity

The TableHelper internally reads from two Y.Map trees:

```typescript
function createTableHelper(tableId: string) {
	const defYMap = doc.getMap('definition').get('tables').get(tableId);
	const rowsYMap = doc.getMap('tables').get(tableId);

	return {
		get name() {
			return defYMap.get('name');
		},
		get fields() {
			return defYMap.get('fields');
		},
		upsert(row) {
			rowsYMap.set(row.id, row);
		},
		observeRows(cb) {
			return rowsYMap.observeDeep(cb);
		},
	};
}
```

This is a small implementation cost for significant observation clarity.

## Conclusion

The three-map structure optimizes for what matters most in a collaborative document system: **observation patterns and change frequency**. Cold data (schemas) and hot data (rows) live in separate trees, enabling precise observers and different sync strategies.

The API abstracts this away. Developers work with unified table helpers. The implementation handles the routing.

This is the kind of decision that's invisible when it works well. You just observe rows and get row changes. You observe fields and get field changes. No surprises, no filtering, no mixed signals.

## References

- [Single Workspace Architecture Spec](../specs/20260123T102500-single-workspace-architecture.md)
- [YJS Documentation](https://docs.yjs.dev/)
