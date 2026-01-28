# Cell Workspace TypeBox Validation

**Created**: 2026-01-28
**Status**: Implemented
**Location**: `packages/epicenter/src/cell`

## Overview

Adds TypeBox validation to cell workspace, providing JIT-compiled validators for advisory schema enforcement. This parallels the core workspace's TypeBox validation while accounting for cell workspace's simpler external schema format.

## Background

Cell workspace uses external JSON schemas (`SchemaFieldDefinition`) that differ from core's `Field` types. The schema is advisory—validation flags issues but doesn't reject data. This requires:

1. A separate converter from `SchemaFieldDefinition` → TypeBox
2. All fields treated as optional and nullable (advisory nature)
3. Additional properties allowed (unknown fields pass validation)

## Architecture

### Components

```
cell/
├── converters/
│   └── to-typebox.ts         # SchemaFieldDefinition → TypeBox converter
├── validation-types.ts       # Cell-level result types
├── validated-table-store.ts  # ValidatedTableStore wrapper
├── types.ts                  # Added validatedTable() to CellWorkspaceClient
└── create-cell-workspace.ts  # Implementation with caching
```

### Result Type Hierarchy

```
Core (row-level)              Cell (cell-level)
─────────────────             ─────────────────
ValidRowResult<T>             ValidCellResult<TValue>
InvalidRowResult              InvalidCellResult
NotFoundResult                NotFoundCellResult
RowResult<T>                  CellResult<TValue>
GetResult<T>                  GetCellResult<TValue>
```

Cell types are exported from `validation-types.ts` alongside re-exports of core types.

## Implementation

### TypeBox Converter

`schemaFieldToTypebox(field)` converts a `SchemaFieldDefinition` to TypeBox:

| FieldType | TypeBox Schema |
|-----------|---------------|
| text, richtext | `Type.Optional(Type.Union([Type.String(), Type.Null()]))` |
| integer | `Type.Optional(Type.Union([Type.Integer(), Type.Null()]))` |
| real | `Type.Optional(Type.Union([Type.Number(), Type.Null()]))` |
| boolean | `Type.Optional(Type.Union([Type.Boolean(), Type.Null()]))` |
| date, datetime | `Type.Optional(Type.Union([Type.String(), Type.Null()]))` |
| select | `Type.Optional(Type.Union([Type.Literal(...), Type.Null()]))` |
| tags | `Type.Optional(Type.Union([Type.Array(...), Type.Null()]))` |
| json | `Type.Optional(Type.Union([Type.Unknown(), Type.Null()]))` |

All fields are wrapped with `Type.Optional()` because missing fields are valid in advisory schemas.

`schemaTableToTypebox(table)` creates a `TObject` with `additionalProperties: true`.

### ValidatedTableStore

Wraps a `TableStore` to add validation:

```typescript
type ValidatedTableStore = {
  tableId: string;
  schema: SchemaTableDefinition;
  raw: TableStore;  // Access underlying store

  // Cell-level validation
  getValidated(rowId, fieldId): GetCellResult<unknown>;

  // Row-level validation
  getRowValidated(rowId): GetResult<RowData>;
  getRowsValidated(): RowResult<RowData>[];
  getRowsValid(): RowData[];
  getRowsInvalid(): InvalidRowResult[];
};
```

Validators are compiled once at construction. Field validators are compiled lazily and cached.

### CellWorkspaceClient Integration

Added `validatedTable(tableId)` method:

```typescript
const validated = workspace.validatedTable('posts');
if (validated) {
  const result = validated.getRowValidated('row-1');
  if (result.status === 'valid') {
    console.log(result.row);
  }
}
```

Returns `undefined` for tables not in schema (dynamic tables). Validated stores are cached per tableId.

## Usage

### Basic Validation

```typescript
import { createCellWorkspace } from '@epicenter/epicenter/cell';

const workspace = createCellWorkspace({
  id: 'my-workspace',
  definition: {
    name: 'Blog',
    tables: {
      posts: {
        name: 'Posts',
        fields: {
          title: { name: 'Title', type: 'text', order: 1 },
          views: { name: 'Views', type: 'integer', order: 2 },
        },
      },
    },
  },
});

const posts = workspace.table('posts');
const rowId = posts.createRow();
posts.set(rowId, 'title', 'Hello');
posts.set(rowId, 'views', 'not a number'); // Wrong type

const validated = workspace.validatedTable('posts')!;

// Cell-level
const cell = validated.getValidated(rowId, 'views');
// { status: 'invalid', key: 'row-1:views', errors: [...], value: 'not a number' }

// Row-level
const row = validated.getRowValidated(rowId);
// { status: 'invalid', id: 'row-1', tableName: 'posts', errors: [...], row: {...} }

// Filter helpers
const validRows = validated.getRowsValid();    // Only valid rows
const invalidRows = validated.getRowsInvalid(); // Only invalid with errors
```

### Direct Store Access

For programmatic use without workspace:

```typescript
import { createValidatedTableStore, createTableStore } from '@epicenter/epicenter/cell';

const tableStore = createTableStore('posts', yarray);
const validated = createValidatedTableStore('posts', tableSchema, tableStore);
```

## API Reference

### Exports from `@epicenter/epicenter/cell`

**Functions:**
- `schemaFieldToTypebox(field)` - Single field → TypeBox TSchema
- `schemaTableToTypebox(table)` - Table definition → TypeBox TObject
- `createValidatedTableStore(tableId, schema, store)` - Create validated wrapper

**Types:**
- `ValidatedTableStore` - The wrapper type
- `ValidCellResult<T>`, `InvalidCellResult`, `NotFoundCellResult`
- `CellResult<T>`, `GetCellResult<T>`
- Re-exports: `ValidationError`, `ValidRowResult`, `InvalidRowResult`, `NotFoundResult`, `RowResult`, `GetResult`

## Tests

- `converters/to-typebox.test.ts` - 33 tests for field type conversion
- `validated-table-store.test.ts` - 14 tests for validation logic

```bash
bun test src/cell/converters/to-typebox.test.ts
bun test src/cell/validated-table-store.test.ts
bun test src/cell/  # All cell tests
```

## Design Decisions

1. **Separate converter** - Cell's `SchemaFieldDefinition` differs structurally from core's `Field`. A separate converter is cleaner than adapting core's.

2. **All fields optional** - Advisory validation means missing fields are valid. `Type.Optional()` wraps all properties.

3. **Additional properties allowed** - `{ additionalProperties: true }` lets unknown fields pass. Data outside schema isn't flagged as invalid.

4. **Dynamic tables return undefined** - `validatedTable()` returns `undefined` for tables not in schema. This is intentional—dynamic tables have no schema to validate against.

5. **Lazy field validator caching** - Row validators compile eagerly (at construction). Field validators compile lazily (on first access per field). Both are cached.
