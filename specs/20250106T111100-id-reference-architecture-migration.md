# ID Reference Architecture Migration

**Status**: Draft  
**Created**: 2025-01-06  
**Author**: AI Assistant  

## Problem Statement

Currently, Epicenter embeds Y.js CRDT types directly into table rows:

- `ytext()` columns store `Y.Text` instances in the `Y.Map` row
- `tags()` columns store `Y.Array<string>` instances in the `Y.Map` row

This tight coupling creates several issues:

1. **Backend Lock-in**: Row schemas are coupled to Y.js. Cannot use the same schema for SQLite-first or markdown-first backends without Y.js overhead.

2. **Complex Serialization**: `serializeCellValue()` must handle Y.Text/Y.Array conversion. `updateYRowFromSerializedRow()` must diff and patch CRDT types.

3. **Markdown Complexity**: Converting rows to/from markdown requires special handling of embedded CRDTs.

4. **No Lazy Loading**: All rich content loads with the row. Cannot lazy-load large documents.

5. **Single Y.Doc Scaling**: All table data lives in one Y.Doc. Large workspaces suffer from memory/sync overhead.

## Proposed Architecture

### The ID Reference Pattern

Instead of embedding CRDT types in rows, store **ID references** to separate Y.Docs:

```
BEFORE (Current):
┌─────────────────────────────────────────────┐
│ Y.Map (Row)                                  │
│   id: "post_123"                             │
│   title: "Hello"                             │
│   content: Y.Text("Full document...")  ←──── Embedded CRDT
│   tags: Y.Array(["a", "b", "c"])       ←──── Embedded CRDT
└─────────────────────────────────────────────┘

AFTER (Proposed):
┌─────────────────────────────────────────────┐
│ Y.Map (Row) - JSON-serializable             │
│   id: "post_123"                             │
│   title: "Hello"                             │
│   content: "rdoc_abc123"               ←──── ID reference
│   tags: ["a", "b", "c"]                ←──── Plain array
└─────────────────────────────────────────────┘
         │
         └──────────────────────────────────────┐
                                                ▼
┌─────────────────────────────────────────────────────────────┐
│ RichContentStore (Separate Y.Docs)                           │
│   "rdoc_abc123" → Y.Doc { content: Y.Text("Full doc...") }  │
│   "rdoc_def456" → Y.Doc { content: Y.XmlFragment(...) }     │
└─────────────────────────────────────────────────────────────┘
```

### Two-Layer Data Model

```
LAYER 1: Workspace Data (Backend-Agnostic)
─────────────────────────────────────────────
- All rows are JSON-serializable primitives
- Rich content columns store ID references
- Works with: Y.js, Markdown files, SQLite, plain JSON

LAYER 2: Rich Document Store (Always Y.js-based)
─────────────────────────────────────────────
- Each rich document is its own Y.Doc
- Identified by ID from Layer 1
- Contains Y.Text (code editors) or Y.XmlFragment (block editors)
- Loaded on-demand, not with row data
```

## Detailed Changes

### 1. Schema Changes (`factories.ts`)

#### Current `ytext()` Definition

```typescript
export function ytext(opts?: { nullable?: boolean }): YtextFieldSchema<boolean> {
  return {
    'x-component': 'ytext',
    type: nullable ? ['string', 'null'] : 'string',
  };
}
```

#### New `richtext()` Definition

```typescript
/**
 * Rich text column - stores an ID reference to a separate Y.Doc.
 * 
 * The actual collaborative content lives in the RichContentStore,
 * not in the row itself. This enables:
 * - JSON-serializable rows (backend agnostic)
 * - Lazy loading of large documents
 * - Independent sync of rich content
 * 
 * @param opts.format - 'text' for Y.Text (code editors), 'blocks' for Y.XmlFragment/blocks
 * @param opts.nullable - Whether the reference can be null
 */
export function richtext(opts: {
  format: 'text' | 'blocks';
  nullable: true;
}): RichtextFieldSchema<true>;
export function richtext(opts: {
  format: 'text' | 'blocks';
  nullable?: false;
}): RichtextFieldSchema<false>;
export function richtext({
  format,
  nullable = false,
}: {
  format: 'text' | 'blocks';
  nullable?: boolean;
}): RichtextFieldSchema<boolean> {
  return {
    'x-component': 'richtext',
    'x-format': format,
    type: nullable ? ['string', 'null'] : 'string',
    pattern: '^rdoc_[a-zA-Z0-9_-]+$', // Validate ID format
  };
}
```

#### Current `tags()` Definition

```typescript
export function tags<TOptions>(opts?: {
  options?: TOptions;
  nullable?: boolean;
  default?: string[];
}): TagsFieldSchema<TOptions, boolean> {
  return {
    'x-component': 'tags',
    type: nullable ? ['array', 'null'] : 'array',
    items: options ? { type: 'string', enum: options } : { type: 'string' },
    uniqueItems: true,
    ...(defaultValue !== undefined && { default: defaultValue }),
  };
}
```

#### New `tags()` Definition (No Changes Needed to Schema)

The schema stays the same, but the **runtime type** changes from `Y.Array<string>` to `string[]`. No more CRDT wrapper.

### 2. Type Changes (`types.ts`)

#### Current `CellValue` Type

```typescript
export type CellValue<C extends FieldSchema = FieldSchema> =
  // ... other types ...
  C extends YtextFieldSchema
    ? IsNullableType<C['type']> extends true
      ? Y.Text | null
      : Y.Text                          // ← Returns Y.Text instance
    : C extends TagsFieldSchema<infer TOptions>
      ? IsNullableType<C['type']> extends true
        ? Y.Array<TOptions[number]> | null
        : Y.Array<TOptions[number]>     // ← Returns Y.Array instance
      : // ...
```

#### New `CellValue` Type

```typescript
export type CellValue<C extends FieldSchema = FieldSchema> =
  // ... other types ...
  C extends RichtextFieldSchema
    ? IsNullableType<C['type']> extends true
      ? string | null                   // ← Now returns ID string
      : string
    : C extends TagsFieldSchema<infer TOptions>
      ? IsNullableType<C['type']> extends true
        ? TOptions[number][] | null     // ← Now returns plain array
        : TOptions[number][]
      : // ...
```

### 3. New `RichtextFieldSchema` Type

```typescript
/**
 * Rich text column schema - stores ID reference to separate Y.Doc.
 * Format determines the content type:
 * - 'text': Y.Text for code editors (Monaco, CodeMirror)
 * - 'blocks': Block-based structure for rich text editors (TipTap, BlockNote)
 */
export type RichtextFieldSchema<TNullable extends boolean = boolean> = {
  'x-component': 'richtext';
  'x-format': 'text' | 'blocks';
  type: TNullable extends true ? readonly ['string', 'null'] : 'string';
  pattern: string; // ID format validation
};
```

### 4. RichContentStore Interface

```typescript
/**
 * Storage for rich collaborative documents.
 * Each document is a separate Y.Doc identified by a unique ID.
 */
export interface RichContentStore {
  /**
   * Get or create a Y.Doc for the given ID.
   * If the document doesn't exist, creates an empty one.
   */
  get(id: string): Y.Doc;
  
  /**
   * Get a Y.Doc only if it exists.
   */
  getIfExists(id: string): Y.Doc | undefined;
  
  /**
   * Check if a document exists.
   */
  has(id: string): boolean;
  
  /**
   * Delete a document.
   */
  delete(id: string): void;
  
  /**
   * Generate a new unique document ID.
   */
  generateId(): string;
  
  /**
   * Get all document IDs.
   */
  keys(): IterableIterator<string>;
  
  /**
   * Observe document changes (additions, deletions).
   */
  observe(callback: (event: RichContentStoreEvent) => void): () => void;
}

export type RichContentStoreEvent = 
  | { type: 'add'; id: string; doc: Y.Doc }
  | { type: 'delete'; id: string };

/**
 * Content accessor for a specific rich document.
 * Provides typed access to the content based on format.
 */
export interface RichDocument<TFormat extends 'text' | 'blocks'> {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly content: TFormat extends 'text' ? Y.Text : Y.XmlFragment;
  
  /**
   * Get plain text content.
   */
  toString(): string;
  
  /**
   * Apply updates from string (for text format).
   */
  applyString?(newContent: string): void;
}
```

### 5. ID Generation Strategy

Use **nanoid** with a `rdoc_` prefix for rich document IDs:

```typescript
import { nanoid } from 'nanoid';

const RICH_DOC_PREFIX = 'rdoc_';

export function generateRichDocId(): string {
  return `${RICH_DOC_PREFIX}${nanoid(16)}`;
}

// Example IDs:
// rdoc_V1StGXR8_Z5jdHi6
// rdoc_FsKx2Lw9_Qm3nPo7
```

Why this format:
- **Prefix**: Makes IDs self-documenting, easy to grep, distinguishes from row IDs
- **Length**: 16 chars = 2^96 combinations, sufficient for any workspace
- **Characters**: URL-safe (`A-Za-z0-9_-`), no special handling needed

### 6. Utilities to Remove/Refactor

#### `updateYTextFromString` (utils/yjs.ts)

**Before**: Used to sync string → Y.Text with diff  
**After**: Move to RichContentStore layer, not needed in row handling

#### `updateYArrayFromArray` (utils/yjs.ts)

**Before**: Used to sync array → Y.Array with diff  
**After**: Remove entirely. Tags are plain arrays.

#### `updateYRowFromSerializedRow` (utils/yjs.ts)

**Before**: Handles Y.Text and Y.Array creation/diffing  
**After**: Simplified - just set primitives on Y.Map

```typescript
// AFTER: Much simpler
export function updateYRowFromSerializedRow<TTableSchema extends TableSchema>({
  yrow,
  serializedRow,
  schema,
}: {
  yrow: YRow;
  serializedRow: PartialSerializedRow<TTableSchema>;
  schema: TTableSchema;
}): void {
  withTransaction(yrow, () => {
    for (const [fieldName, value] of Object.entries(serializedRow)) {
      if (value === undefined) continue;
      
      const existing = yrow.get(fieldName);
      if (existing !== value) {
        yrow.set(fieldName, value); // All values are primitives now
      }
    }
  });
}
```

#### `serializeCellValue` (runtime/serialization.ts)

**Before**: Converts Y.Text/Y.Array to primitives  
**After**: Identity function (all values already primitives)

```typescript
// AFTER: Trivial
export function serializeCellValue<T extends FieldSchema>(
  value: CellValue<T>,
): SerializedCellValue<T> {
  return value as SerializedCellValue<T>; // Already serialized!
}
```

## Migration Path

### Phase 1: Add New Types (Non-Breaking)

1. Add `richtext()` factory alongside existing `ytext()`
2. Add `RichtextFieldSchema` type
3. Add `RichContentStore` interface and implementation
4. Update `CellValue` to handle new `richtext` component

**Compatibility**: Existing workspaces continue working. New workspaces can opt into new pattern.

### Phase 2: Migrate Existing Workspaces

For workspaces using `ytext()`:

1. **Detection**: Scan for `'x-component': 'ytext'` columns
2. **Migration**:
   - For each row with Y.Text content:
     - Generate new rich doc ID
     - Create Y.Doc in RichContentStore
     - Copy Y.Text content to new Y.Doc
     - Replace Y.Text in row with ID string
3. **Schema Update**: Change column from `ytext()` to `richtext({ format: 'text' })`

```typescript
async function migrateYtextToRichtext(
  workspace: Workspace,
  tableName: string,
  columnName: string,
  store: RichContentStore,
): Promise<void> {
  const table = workspace.tables[tableName];
  const rows = table.getAll();
  
  for (const result of rows) {
    if (result.status !== 'valid') continue;
    
    const row = result.row;
    const ytext = row[columnName] as Y.Text | null;
    
    if (ytext && ytext instanceof Y.Text) {
      // Generate new ID
      const docId = store.generateId();
      
      // Create new Y.Doc with content
      const doc = store.get(docId);
      const newYtext = doc.getText('content');
      newYtext.insert(0, ytext.toString());
      
      // Update row with ID reference
      table.update({ id: row.id, [columnName]: docId });
    }
  }
}
```

### Phase 3: Deprecate `ytext()` (Future)

After migration tooling is stable:

1. Mark `ytext()` as deprecated
2. Log warnings when used
3. Eventually remove in major version

### Phase 4: Simplify Tags (Future)

Change `tags()` runtime from `Y.Array` to plain arrays:

1. For each row with Y.Array tags:
   - Convert to plain array: `yarray.toArray()`
   - Replace in row Y.Map
2. Remove Y.Array handling from update functions

## RichContentStore Implementation

```typescript
import * as Y from 'yjs';
import { nanoid } from 'nanoid';

const RICH_DOC_PREFIX = 'rdoc_';

export function createRichContentStore(
  rootDoc: Y.Doc,
  persistenceProvider?: (doc: Y.Doc, id: string) => void,
): RichContentStore {
  // Store documents in a Y.Map on the root doc for sync
  const docsMap = rootDoc.getMap<Y.Doc>('richDocs');
  const observers = new Set<(event: RichContentStoreEvent) => void>();
  
  // Observe changes to the map
  docsMap.observe((event) => {
    event.changes.keys.forEach((change, key) => {
      if (change.action === 'add') {
        const doc = docsMap.get(key);
        if (doc) {
          observers.forEach(cb => cb({ type: 'add', id: key, doc }));
        }
      } else if (change.action === 'delete') {
        observers.forEach(cb => cb({ type: 'delete', id: key }));
      }
    });
  });
  
  return {
    get(id: string): Y.Doc {
      let doc = docsMap.get(id);
      if (!doc) {
        doc = new Y.Doc({ guid: id });
        docsMap.set(id, doc);
        persistenceProvider?.(doc, id);
      }
      return doc;
    },
    
    getIfExists(id: string): Y.Doc | undefined {
      return docsMap.get(id);
    },
    
    has(id: string): boolean {
      return docsMap.has(id);
    },
    
    delete(id: string): void {
      const doc = docsMap.get(id);
      if (doc) {
        doc.destroy();
        docsMap.delete(id);
      }
    },
    
    generateId(): string {
      return `${RICH_DOC_PREFIX}${nanoid(16)}`;
    },
    
    keys(): IterableIterator<string> {
      return docsMap.keys();
    },
    
    observe(callback: (event: RichContentStoreEvent) => void): () => void {
      observers.add(callback);
      return () => observers.delete(callback);
    },
  };
}
```

## Benefits After Migration

### 1. Backend Agnosticism

```typescript
// Same schema works everywhere
const postsSchema = {
  id: id(),
  title: text(),
  content: richtext({ format: 'blocks' }), // Just a string ID
  tags: tags(),                             // Just an array
};

// Yjs backend: Rows in Y.Map, rich docs in RichContentStore
// SQLite backend: Rows in SQLite, rich docs still in Y.Docs
// Markdown backend: Rows as frontmatter, rich docs as separate files
```

### 2. Simpler Markdown Serialization

```typescript
// BEFORE: Complex CRDT handling
function rowToMarkdown(row: Row): string {
  const frontmatter = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Y.Text) {
      frontmatter[key] = value.toString(); // Special handling
    } else if (value instanceof Y.Array) {
      frontmatter[key] = value.toArray();  // Special handling
    } else {
      frontmatter[key] = value;
    }
  }
  // ...
}

// AFTER: Just JSON
function rowToMarkdown(row: Row): string {
  const frontmatter = row.toJSON(); // Already all primitives!
  // ...
}
```

### 3. Lazy Loading

```typescript
// Only load rich content when needed
const post = table.get({ id: 'post_123' });
// Row loaded, but rich doc not yet loaded

// Load on demand
const docId = post.content; // "rdoc_abc123"
const doc = richContentStore.get(docId);
const content = doc.getText('content');
```

### 4. Independent Sync

```typescript
// Rich docs can sync independently
// Perfect for large documents that change frequently
// Without affecting row sync traffic
```

## Considerations

### Y.js Subdocuments vs Separate Y.Docs

We considered using Y.js subdocuments (nested Y.Docs within a parent), but chose separate Y.Docs because:

1. **Simpler persistence**: Each doc is its own file
2. **Flexible loading**: No lazy-load complexity with `.load()`
3. **Clear boundaries**: Rich content is truly separate
4. **Provider flexibility**: Can use different providers per doc

### y-utility's YKeyValue (Future Optimization)

The `YKeyValue` class from y-utility is more efficient than Y.Map for key-value storage where keys change frequently. This could be used in Phase 2 for internal row storage, but is out of scope for this migration.

## Files Changed

| File | Change |
|------|--------|
| `core/schema/fields/factories.ts` | Add `richtext()`, keep `ytext()` deprecated |
| `core/schema/fields/types.ts` | Add `RichtextFieldSchema`, update `CellValue` |
| `core/utils/yjs.ts` | Simplify `updateYRowFromSerializedRow`, deprecate Y.Text/Y.Array helpers |
| `core/schema/runtime/serialization.ts` | Simplify `serializeCellValue` |
| `core/rich-content/store.ts` | **NEW**: RichContentStore implementation |
| `core/rich-content/types.ts` | **NEW**: RichContentStore types |
| `providers/markdown/` | Simplified - no CRDT handling in rows |
| `providers/sqlite/` | Simplified - no CRDT handling in rows |

## Open Questions

1. **Block editor format**: Should `format: 'blocks'` use Y.XmlFragment or AFFiNE-style Y.Map+Y.Array? (Research suggests Y.Map+Y.Array is easier to serialize)

2. **Migration tooling**: Should migration be automatic on workspace load, or require explicit user action?

3. **Orphan cleanup**: How to garbage collect rich docs no longer referenced by any row?

4. **Cross-workspace references**: Can rich docs be shared between workspaces?

## Timeline

- **Phase 1** (Add new types): 1-2 weeks
- **Phase 2** (Migration tooling): 2-3 weeks  
- **Phase 3** (Deprecate ytext): After 2 releases with warnings
- **Phase 4** (Simplify tags): Can be done independently, ~1 week
