# Schema Folder Separation: Fields vs Standard Schema

**Created**: 2026-01-01T01:15:00
**Status**: Planning
**Branch**: `refactor/columns-to-fields` (can continue here or create new branch)

## Problem Statement

The `packages/epicenter/src/core/schema/converters/` folder mixes two conceptually different schema systems:

1. **FieldDefinition converters** - Convert Epicenter's custom schema DSL (`id()`, `text()`, `select()`) to various formats for storage/validation
2. **Standard Schema converters** - Convert external schemas (ArkType, Zod, etc.) to JSON Schema for CLI/MCP/OpenAPI

These have different input types, different consumers, and different purposes. The current organization obscures this distinction.

## The Two Schema Systems

### 1. FieldDefinition System (Epicenter's Custom DSL)

**What it is**: Epicenter's domain-specific language for defining table and KV schemas.

**Factory functions** (in `fields.ts`):

```typescript
id(); // Primary key
text(); // String column
ytext(); // Collaborative Y.Text column
integer(); // Integer column
real(); // Float column
boolean(); // Boolean column
date(); // DateWithTimezone column
select(); // Enum/single-choice column
tags(); // String array column
json(); // JSON column with arktype validation
```

**Used for**:

- Defining table schemas in workspaces
- Defining KV store schemas
- Generating Drizzle columns for SQLite
- Generating ArkType validators for row validation
- Generating ArkType-YJS validators for YJS row validation

**Type**: `FieldDefinition` (defined in `types.ts`)

### 2. Standard Schema System (External Schemas)

**What it is**: The [Standard Schema](https://standardschema.dev) specification - a vendor-agnostic interface implemented by ArkType, Zod, Valibot, etc.

**Used for**:

- Defining action/handler `input:` schemas
- Converting to JSON Schema for CLI flags (yargs)
- Converting to JSON Schema for MCP tool definitions
- Converting to JSON Schema for OpenAPI specs

**Type**: `StandardSchemaV1` / `StandardJSONSchemaV1` (defined in `standard-schema.ts`)

## Current File Organization

```
packages/epicenter/src/core/schema/
├── converters/
│   ├── arktype.ts              # FieldDefinition → ArkType
│   ├── arktype-yjs.ts          # FieldDefinition → ArkType (YJS types)
│   ├── arktype-yjs.test.ts
│   ├── arktype.test.ts
│   ├── arktype-fallback.ts     # ArkType JSON Schema fallbacks
│   ├── drizzle.ts              # FieldDefinition → Drizzle columns
│   └── json-schema.ts          # StandardSchema → JSON Schema
├── fields.ts                   # FieldDefinition factory functions
├── types.ts                    # FieldDefinition type definitions
├── standard-schema.ts          # StandardSchema type definitions
├── validation.ts               # Creates validators from FieldDefinition
├── validation.test.ts
├── nullability.ts              # FieldDefinition nullability utilities
├── serialization.ts            # FieldDefinition value serialization
├── date-with-timezone.ts       # DateWithTimezone utilities
├── id.ts                       # ID generation
├── regex.ts                    # Regex patterns
├── regex.test.ts
├── README.md
└── index.ts                    # Barrel exports
```

## Dependency Graph

### FieldDefinition Converters

| File             | Converts                                                 | Consumers                             |
| ---------------- | -------------------------------------------------------- | ------------------------------------- |
| `arktype.ts`     | `FieldDefinition` → `arktype.Type`                       | `validation.ts`                       |
| `arktype-yjs.ts` | `FieldDefinition` → `arktype.Type` (with Y.Text/Y.Array) | `validation.ts`                       |
| `drizzle.ts`     | `TableSchema` → Drizzle `SQLiteTable`                    | `providers/sqlite/sqlite-provider.ts` |

### Standard Schema Converters

| File                  | Converts                              | Consumers                                               |
| --------------------- | ------------------------------------- | ------------------------------------------------------- |
| `json-schema.ts`      | `StandardJSONSchemaV1` → `JsonSchema` | `cli/standard-json-schema-to-yargs.ts`, `server/mcp.ts` |
| `arktype-fallback.ts` | N/A (fallback handlers)               | `json-schema.ts` only                                   |

### Visual Dependency Graph

```
                     ┌─────────────────────────────────────────┐
                     │           CONSUMERS                      │
                     └─────────────────────────────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         │                            │                            │
         ▼                            ▼                            ▼
┌─────────────────┐      ┌─────────────────────┐      ┌─────────────────┐
│  validation.ts  │      │  cli/standard-json- │      │   server/mcp.ts │
│                 │      │  schema-to-yargs.ts │      │                 │
└────────┬────────┘      └──────────┬──────────┘      └────────┬────────┘
         │                          │                          │
         │                          └──────────┬───────────────┘
         │                                     │
         ▼                                     ▼
┌─────────────────────────────┐    ┌─────────────────────────────┐
│  FIELDDEFINITION CONVERTERS │    │  STANDARD SCHEMA CONVERTERS │
├─────────────────────────────┤    ├─────────────────────────────┤
│ • arktype.ts                │    │ • json-schema.ts            │
│ • arktype-yjs.ts            │    │ • arktype-fallback.ts       │
│ • drizzle.ts                │    │                             │
└─────────────────────────────┘    └─────────────────────────────┘
         │                                     │
         ▼                                     ▼
   FieldDefinition                       StandardSchemaV1
   (id(), text(), select())             (type({...}), z.object())
```

## Key Functions in Each File

### FieldDefinition Converters

**`arktype.ts`**:

- `tableSchemaToArktype<TSchema>(schema)` - Converts full table schema to arktype validator
- `fieldDefinitionToArktype<C>(fieldDefinition)` - Converts single field to arktype type string

**`arktype-yjs.ts`**:

- `tableSchemaToYjsArktype<TSchema>(schema)` - Like above but uses Y.Text/Y.Array for ytext/tags columns
- `fieldDefinitionToYjsArktype<C>(fieldDefinition)` - Like above for single field

**`drizzle.ts`**:

- `convertWorkspaceSchemaToDrizzle(schema)` - Converts workspace schema to Drizzle tables
- `convertTableSchemaToDrizzle(tableName, tableSchema)` - Converts single table
- `convertFieldDefinitionToDrizzle(name, field)` - Converts single field to Drizzle column builder

### Standard Schema Converters

**`json-schema.ts`**:

- `generateJsonSchema(schema: StandardJSONSchemaV1)` - Converts Standard Schema to JSON Schema using `~standard.jsonSchema.input()` interface

**`arktype-fallback.ts`**:

- `ARKTYPE_JSON_SCHEMA_FALLBACK` - Object with fallback handlers for arktype-specific conversion issues:
  - `unit` handler: Strips `undefined` from unions (JSON Schema handles optionality via `required` array)
  - `domain` handler: Handles unconvertible domain types

## Refactoring Options

### Option A: Rename Files for Clarity (Minimal Change)

Rename files to make the distinction obvious at a glance:

| Current               | Proposed                     |
| --------------------- | ---------------------------- |
| `arktype.ts`          | `field-to-arktype.ts`        |
| `arktype-yjs.ts`      | `field-to-arktype-yjs.ts`    |
| `drizzle.ts`          | `field-to-drizzle.ts`        |
| `json-schema.ts`      | `standard-to-json-schema.ts` |
| `arktype-fallback.ts` | `arktype-json-fallback.ts`   |

**Pros**: Minimal disruption, immediate clarity
**Cons**: Doesn't address structural mixing

### Option B: Separate into Subfolders

```
schema/
├── fields/                         # FieldDefinition system
│   ├── types.ts                    # FieldDefinition type definitions
│   ├── factories.ts                # id(), text(), select() - renamed from fields.ts
│   ├── nullability.ts
│   ├── serialization.ts
│   └── converters/
│       ├── to-arktype.ts
│       ├── to-arktype-yjs.ts
│       ├── to-arktype.test.ts
│       ├── to-arktype-yjs.test.ts
│       └── to-drizzle.ts
│
├── standard/                       # Standard Schema utilities
│   ├── types.ts                    # StandardSchemaV1 definitions (moved from standard-schema.ts)
│   ├── to-json-schema.ts
│   └── arktype-fallback.ts
│
├── validation.ts                   # Uses both systems
├── date-with-timezone.ts           # Shared utility
├── id.ts                           # Shared utility
├── regex.ts                        # Shared utility
├── README.md
└── index.ts                        # Re-exports from both
```

**Pros**: Clear structural separation, logical grouping
**Cons**: More files to move, more import updates

### Option C: Move Standard Schema Utils Out of `schema/`

Since `json-schema.ts` and `arktype-fallback.ts` are only used by CLI and MCP, move them closer to consumers:

```
cli/
├── standard-json-schema-to-yargs.ts
├── standard-schema-to-json.ts       # Moved from schema/converters/json-schema.ts
└── arktype-json-fallback.ts         # Moved from schema/converters/arktype-fallback.ts

schema/converters/                   # Now purely FieldDefinition converters
├── arktype.ts
├── arktype-yjs.ts
└── drizzle.ts
```

Or create a shared location:

```
core/
├── schema/                          # FieldDefinition only
└── standard-schema/                 # Standard Schema utilities
    ├── types.ts
    ├── to-json-schema.ts
    └── arktype-fallback.ts
```

**Pros**: Schema folder becomes purely about FieldDefinition
**Cons**: `generateJsonSchema` is currently exported from `schema/index.ts` and would need a new home

## Recommendation

**Start with Option A** (rename files) as a low-risk first step. This:

1. Makes the distinction immediately visible
2. Is easily reversible
3. Validates the mental model before bigger changes

**Then consider Option B** if the codebase grows and clearer separation becomes valuable.

## Files Requiring Import Updates (for Option A)

1. `schema/index.ts` - Update export paths
2. `schema/validation.ts` - Update import from arktype converters
3. `cli/standard-json-schema-to-yargs.ts` - Uses `generateJsonSchema` via `schema/index.ts` (no change needed if re-export updated)
4. `server/mcp.ts` - Same as above
5. `providers/sqlite/sqlite-provider.ts` - Uses drizzle converter
6. `providers/sqlite/schema/index.ts` - Uses drizzle converter

## Current Export Structure (schema/index.ts)

```typescript
// Field factories
export {
	boolean,
	date,
	id,
	integer,
	json,
	real,
	select,
	tags,
	text,
	ytext,
} from './fields';

// FieldDefinition → ArkType
export type { FieldDefinitionToArktype } from './converters/arktype';

// FieldDefinition → Drizzle
export type { WorkspaceSchemaToDrizzleTables } from './converters/drizzle';
export {
	convertTableSchemaToDrizzle,
	convertWorkspaceSchemaToDrizzle,
} from './converters/drizzle';

// StandardSchema → JSON Schema
export { generateJsonSchema } from './converters/json-schema';

// ... other exports
```

## Open Questions

1. Should `validation.ts` stay at the root or move into `fields/`? It operates on FieldDefinition but is a major consumer.

2. Should `standard-schema.ts` (type definitions) stay at root or move into a `standard/` folder?

3. Is there value in renaming `fields.ts` to `factories.ts` to distinguish it from the `fields/` folder (if we create one)?

4. Should the test files follow the same rename pattern?

## Todo

- [ ] Decide on refactoring approach (A, B, or C)
- [ ] Rename converter files (if Option A)
- [ ] Update imports in consumer files
- [ ] Update exports in `schema/index.ts`
- [ ] Update tests if file names changed
- [ ] Run `bun test` to verify nothing broke
- [ ] Run `bun check` for type checking
- [ ] Update README.md if structure changed significantly

## Related Context

- Previous work: Renamed `columns` → `fields` terminology (PR #1195)
- Previous work: Moved `arktype-fallback.ts` and `generate-json-schema.ts` into `converters/` folder
- The `standard-json-schema-to-yargs.ts` file in `cli/` is a good example of how Standard Schema → JSON Schema conversion is used

## Session Context

This analysis was done in conversation on 2026-01-01. Key insights:

- User noticed the conceptual mixing while reviewing `standard-json-schema-to-yargs.ts`
- Four parallel explore agents confirmed the two-system hypothesis
- Dependency analysis showed zero overlap between FieldDefinition and Standard Schema converter consumers
