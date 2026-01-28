# External Schema Architecture

**Created**: 2026-01-27
**Status**: Active
**Related**: `20260128T100000-table-partitioned-storage.md` (Y.Doc structure), `packages/epicenter/src/cell`

> **Note**: This spec defines the conceptual separation of schema (external JSON) from data (Y.Doc).
> For the specific Y.Doc internal structure, see `20260128T100000-table-partitioned-storage.md`.

## Problem Statement

The current architecture stores schema definitions INSIDE the Y.Doc:
- Static API: Schema in code, merged into Y.Doc
- Dynamic API: Schema in Y.Doc (`Y.Map('definition')`)

This creates complexity:
1. Schema changes must go through CRDT sync
2. Schema conflicts are possible (concurrent field renames, etc.)
3. Epoch/versioning system needed for schema migrations
4. Heavy machinery for what might be simple configuration

## Proposed Architecture

**Core Insight**: Separate schema (local config) from data (synced CRDT).

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PROPOSED ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────┐    ┌─────────────────────────────────┐ │
│  │     SCHEMA (Local JSON)         │    │      DATA (Y.Doc / CRDT)        │ │
│  │                                 │    │                                 │ │
│  │  • Table definitions            │    │  • Cell values only             │ │
│  │  • Field names, types, order    │    │  • Cell-level LWW               │ │
│  │  • Display preferences          │    │  • Syncs between devices        │ │
│  │  • NOT synced                   │    │  • No schema validation         │ │
│  │  • User-editable JSON           │    │  • Just raw key-value pairs     │ │
│  │                                 │    │                                 │ │
│  │  Lives at:                      │    │  Lives at:                      │ │
│  │  {workspaceId}.json             │    │  {workspaceId}/workspace.yjs    │ │
│  └─────────────────────────────────┘    └─────────────────────────────────┘ │
│                                                                             │
│              Schema is the LENS through which you VIEW the data             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## File System Structure

```
{appLocalDataDir}/
├── workspaces/
│   ├── {workspaceId}.json           # Schema definitions (local only)
│   ├── {workspaceId}/
│   │   ├── workspace.yjs            # CRDT data (tables as cells)
│   │   └── workspace.json           # Human-readable export (optional)
│   │
│   ├── {workspaceId2}.json
│   └── {workspaceId2}/
│       └── ...
```

### Schema File Format (`{workspaceId}.json`)

```jsonc
{
  "name": "My Workspace",
  "icon": "📝",
  "tables": {
    "posts": {
      "name": "Blog Posts",
      "icon": "📰",
      "fields": {
        "title": { "name": "Title", "type": "text", "order": 1 },
        "published": { "name": "Published", "type": "boolean", "order": 2 },
        "views": { "name": "Views", "type": "integer", "order": 3 }
      }
    },
    "comments": {
      "name": "Comments",
      "fields": { ... }
    }
  },
  "kv": {
    "theme": { "name": "Theme", "type": "select", "options": ["light", "dark"] }
  }
}
```

### Data Storage Format (Y.Doc)

> **See**: `20260128T100000-table-partitioned-storage.md` for the full Y.Doc structure.

The Y.Doc uses **table-partitioned storage** with `Y.Map` of `Y.Array`:

```
Y.Doc
├── Y.Map('cells')              ← One Y.Array per table
│   ├── 'posts' → Y.Array       ← YKeyValueLww<CellValue>
│   │   ├── { key: 'row1:title', val: 'Hello', ts: ... }
│   │   └── { key: 'row1:published', val: true, ts: ... }
│   └── 'comments' → Y.Array
│
├── Y.Map('rows')               ← One Y.Array per table
│   ├── 'posts' → Y.Array       ← YKeyValueLww<RowMeta>
│   │   └── { key: 'row1', val: { order: 1, deletedAt: null }, ts: ... }
│   └── 'comments' → Y.Array
│
└── Y.Array('kv')               ← YKeyValueLww<unknown>
    └── { key: 'theme', val: 'dark', ts: ... }
```

**Key Insight**: The Y.Doc has NO idea about "tables" or "fields" as concepts. It just stores cells. The `tableId` is encoded in the Y.Map key, not the cell key—this enables table-scoped reads (O(table size) instead of O(total cells)).

## Design Questions

### Q1: If schema isn't synced, how do collaborators share schema changes?

**Options**:

A. **Schema is truly local** - Each user defines their own view
   - Pro: Maximum flexibility, no conflicts
   - Con: Collaborators see different structures

B. **Schema shared out-of-band** - Export/import schema JSON
   - Pro: Explicit sharing when desired
   - Con: Manual process

C. **Schema in a separate sync channel** - Not in same Y.Doc but synced separately
   - Pro: Best of both worlds
   - Con: Complexity returns

**Recommendation**: Start with (A), allow (B) via export/import. (C) can come later.

### Q2: What happens when data doesn't match schema?

**Scenarios**:

1. **Cell exists but field not in schema**
   - Display as "unknown field" or hide
   - Data preserved, not deleted

2. **Field in schema but cell doesn't exist**
   - Display as empty/null
   - No data created until user edits

3. **Cell type doesn't match field type**
   - Display with warning indicator
   - Allow editing to fix

4. **Row exists in data but table not in schema**
   - Data orphaned but preserved
   - Can add table to schema to "recover"

**Key Principle**: Schema is advisory. Data is authoritative.

### Q3: Do we need KV separate from tables?

**Arguments for keeping KV**:
- Single values (not rows) are common
- Settings, preferences, flags
- Simpler API: `kv.get('theme')` vs `tables.settings.get('theme').cells.value`

**Arguments for removing KV**:
- Everything could be a single-row table
- Reduces API surface
- One fewer concept to explain

**Recommendation**: Keep KV for simplicity, but make it optional.

### Q4: Do we need row ordering?

**Options**:

A. **No row order** - Rows are unordered set
   - Pro: Simpler, less conflict potential
   - Con: Can't represent ordered lists

B. **Order as cell** - `{tableId}:{rowId}:_order` cell
   - Pro: Uses existing cell mechanism
   - Con: Special field, ordering conflicts

C. **Separate rows array** - Like current dynamic implementation
   - Pro: Clean separation
   - Con: More storage overhead

**Recommendation**: (C) - Keep separate rows array with `order` property.

## Implementation Simplifications

### Remove Epochs

The current architecture has epochs for schema versioning. With external schema:
- No need for epochs
- Workspace = single Y.Doc
- Schema changes = edit JSON file, reload

### Remove Head Doc

Head Doc exists for:
1. Workspace identity (name, icon) → Move to schema JSON
2. Epoch tracking → Not needed

With external schema, Head Doc becomes unnecessary.

### Simplify to Two Files

Per workspace:
1. `{workspaceId}.json` - Schema + identity
2. `{workspaceId}/workspace.yjs` - Data

That's it. No epochs, no head doc, no definition syncing.

## API Design

### Reading Workspace

```typescript
// Load schema from filesystem
const schema = await loadSchema(workspaceId);
// schema: { name, icon, tables: {...}, kv: {...} }

// Load data from Y.Doc
const workspace = createCellWorkspace({ id: workspaceId });
await workspace.whenSynced;

// Combine for typed access
const posts = workspace.table('posts', schema.tables.posts);
// Returns helper that knows field types from schema
```

### Writing Data

```typescript
// Schema provides type hints, but NOT enforced
posts.setCell(rowId, 'title', 'Hello World');

// Can write cells for fields not in schema
posts.setCell(rowId, 'unknownField', 'whatever');

// Can write wrong types (schema mismatch, but allowed)
posts.setCell(rowId, 'views', 'not a number');  // Stores as-is
```

### Reading Data

```typescript
// Get all cells for a row
const row = posts.getRow(rowId);
// { title: 'Hello World', published: true, views: 100 }

// Schema helps interpret types
const typedRow = posts.getTypedRow(rowId, schema.tables.posts);
// {
//   title: { value: 'Hello World', type: 'text', valid: true },
//   published: { value: true, type: 'boolean', valid: true },
//   views: { value: 100, type: 'integer', valid: true }
// }
```

## Migration Path

From current dynamic implementation:
1. Extract definitions from Y.Doc → Write to external JSON
2. Keep cell storage as-is (already cell-level)
3. Remove definition-related code from Y.Doc
4. Update persistence to new file structure

## Comparison Table

| Aspect | Static API | Dynamic API (current) | External Schema (proposed) |
|--------|-----------|----------------------|---------------------------|
| Schema location | Code | Y.Doc | Local JSON file |
| Schema synced | N/A (compile time) | Yes (CRDT) | No (local only) |
| Validation | On read | On read | Advisory only |
| Data granularity | Row-level | Cell-level | Cell-level |
| Conflict resolution | Row LWW | Cell LWW | Cell LWW |
| Epochs | No | Yes | No |
| Head Doc | No | Yes | No |
| Complexity | Low | High | Medium |

## Open Questions

1. **Schema sharing**: How do teams share schema definitions?
   - Git commit the JSON?
   - Export/import UI?
   - Separate sync mechanism later?

2. **Schema versioning**: What if schema format itself evolves?
   - Version field in JSON?
   - Migration functions in code?

3. **Default values**: Should schema define defaults for new cells?
   - Or is that a UI concern?

4. **Computed fields**: Should schema support formulas/computations?
   - Probably a separate feature

5. **Rich text cells**: How do Y.Text fields work with this model?
   - Store docId reference in cell
   - Separate Y.Doc for rich content

## Next Steps

1. [ ] Decide on schema sharing approach
2. [ ] Design schema JSON format precisely
3. [ ] Implement `CellWorkspace` (simplified Y.Doc wrapper)
4. [ ] Implement schema file loading/saving
5. [ ] Create migration utility from current format
6. [ ] Update persistence layer for new file structure

---

## Appendix: Filesystem Visualization

```
~/.local/share/com.epicenter.app/     # macOS/Linux appLocalDataDir
├── registry.json                      # List of workspace IDs
└── workspaces/
    ├── abc123.json                    # Workspace "abc123" schema
    │   {
    │     "name": "My Notes",
    │     "icon": "📝",
    │     "tables": {
    │       "notes": {
    │         "name": "Notes",
    │         "fields": {
    │           "title": { "type": "text", "order": 1 },
    │           "content": { "type": "richtext", "order": 2 }
    │         }
    │       }
    │     }
    │   }
    │
    ├── abc123/
    │   └── workspace.yjs              # CRDT data
    │
    ├── def456.json                    # Another workspace schema
    └── def456/
        └── workspace.yjs
```
