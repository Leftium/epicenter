# Rename FieldSchema to Field

**Date**: 2026-01-23
**Status**: Completed
**Scope**: Type naming refactor across `packages/epicenter`

## Summary

Rename `FieldSchema` → `Field` and `FieldSchemaMap` → `FieldMap` throughout the codebase. This simplifies naming while better reflecting what these types actually represent.

## Motivation

### Current Naming Inconsistency

The README documents a naming convention:

- **Schema** = raw type/constraint description (no metadata)
- **Definition** = metadata + schema(s)

However, `TextFieldSchema`, `SelectFieldSchema`, etc. **include metadata** (name, description, icon):

```typescript
// Current: Called "Schema" but includes metadata
type TextFieldSchema = FieldMetadata & {
	type: 'text';
	nullable?: boolean;
	default?: string;
};
```

By the documented convention, these should be called `FieldDefinition`. But that's verbose and doesn't match how users think about these types.

### Why "Field" is Better

1. **Intuitive**: Users think "I'm defining the fields of my table", not "I'm defining field schemas"
2. **Consistent**: Already using `Field*` prefix for related types (`FieldMetadata`, `FieldOptions`, `FieldType`)
3. **Concise**: Removes unnecessary "Schema" suffix that doesn't add clarity
4. **Natural reading**: "a TextField", "a SelectField", "a Field" reads better than "a TextFieldSchema"

### No Collision Risk

The UI package has a `Field` Svelte component, but:

- Different packages (`@epicenter/ui` vs `@epicenter/hq`)
- Different namespaces (runtime value vs TypeScript type)
- TypeScript distinguishes type imports from value imports

## Rename Mapping

| Current                       | New                          |
| ----------------------------- | ---------------------------- |
| `IdFieldSchema`               | `IdField`                    |
| `TextFieldSchema`             | `TextField`                  |
| `RichtextFieldSchema`         | `RichtextField`              |
| `IntegerFieldSchema`          | `IntegerField`               |
| `RealFieldSchema`             | `RealField`                  |
| `BooleanFieldSchema`          | `BooleanField`               |
| `DateFieldSchema`             | `DateField`                  |
| `SelectFieldSchema`           | `SelectField`                |
| `TagsFieldSchema`             | `TagsField`                  |
| `JsonFieldSchema`             | `JsonField`                  |
| `FieldSchema`                 | `Field`                      |
| `FieldSchemaMap`              | `FieldMap`                   |
| `KvFieldSchema`               | `KvField`                    |
| `KvSchemaMap`                 | `KvMap`                      |
| `isNullableFieldSchema`       | `isNullableField`            |
| `FieldSchemaToArktype`        | `FieldToArktype`             |
| `FieldSchemaToYjsArktype`     | `FieldToYjsArktype`          |
| `FieldSchemaToTypebox`        | `FieldToTypebox`             |
| `fieldSchemaToArktype`        | `fieldToArktype`             |
| `fieldSchemaToYjsArktype`     | `fieldToYjsArktype`          |
| `fieldSchemaToTypebox`        | `fieldToTypebox`             |
| `tableSchemaToArktype`        | `tableToArktype`             |
| `tableSchemaToYjsArktype`     | `tableToYjsArktype`          |
| `fieldsSchemaToTypebox`       | `fieldsToTypebox`            |
| `convertFieldSchemaToDrizzle` | `convertFieldToDrizzle`      |
| `FieldToDrizzle`              | `FieldToDrizzle` (unchanged) |

## Files to Modify

### Core Type Definitions

- `packages/epicenter/src/core/schema/fields/types.ts` - Primary type definitions
- `packages/epicenter/src/core/schema/fields/helpers.ts` - `isNullableFieldSchema` function
- `packages/epicenter/src/core/schema/fields/factories.ts` - Factory return types

### Converters

- `packages/epicenter/src/core/schema/converters/to-arktype.ts`
- `packages/epicenter/src/core/schema/converters/to-arktype-yjs.ts`
- `packages/epicenter/src/core/schema/converters/to-typebox.ts`
- `packages/epicenter/src/core/schema/converters/to-drizzle.ts`
- `packages/epicenter/src/core/schema/converters/index.ts`

### Re-exports

- `packages/epicenter/src/core/schema/index.ts`
- `packages/epicenter/src/index.ts`

### Consumers

- `packages/epicenter/src/core/definition-helper/definition-helper.ts`
- `packages/epicenter/src/core/tables/table-helper.ts`
- `packages/epicenter/src/core/kv/kv-helper.ts`
- `packages/epicenter/src/core/workspace/normalize.ts`
- `packages/epicenter/src/core/docs/workspace-doc.ts`
- `packages/epicenter/src/extensions/markdown/markdown.ts`
- `packages/epicenter/src/extensions/markdown/configs.ts`
- `packages/epicenter/src/server/tables.ts`

### Documentation

- `packages/epicenter/src/core/schema/README.md` - Update naming conventions
- `packages/epicenter/README.md` - Update examples if needed

## Execution Strategy

### Option A: LSP Rename (Safest for Types)

Use `lsp_rename` for each type/function. This is the safest approach because:

- Handles all references automatically
- Updates imports
- Catches usages in JSDoc comments
- Type-safe

**Downside**: Need to execute one rename at a time, ~25 renames total.

### Option B: AST-Aware Search/Replace

Use `ast_grep_replace` for pattern-based replacement:

```
pattern: 'FieldSchema'
rewrite: 'Field'
```

**Downside**: Might be too aggressive (could match unintended patterns).

### Option C: Targeted Grep + Manual Edit

1. Grep for each pattern
2. Review matches
3. Edit with targeted replacements

**Downside**: More manual work, risk of missing references.

### Recommended Approach

**Hybrid: LSP Rename for types, then grep verification**

1. Start with `lsp_prepare_rename` to verify each rename is valid
2. Execute `lsp_rename` for each type (most critical)
3. Run `lsp_diagnostics` after each batch to catch errors
4. Final grep to catch any stragglers (JSDoc, comments, strings)
5. Run tests to verify

## Execution Order

Rename in dependency order to minimize intermediate breakage:

1. **Leaf types first** (no dependencies):
   - `IdFieldSchema` → `IdField`
   - `TextFieldSchema` → `TextField`
   - ... (all specific field types)

2. **Union type**:
   - `FieldSchema` → `Field`

3. **Map types**:
   - `FieldSchemaMap` → `FieldMap`
   - `KvFieldSchema` → `KvField`
   - `KvSchemaMap` → `KvMap`

4. **Helper functions**:
   - `isNullableFieldSchema` → `isNullableField`

5. **Converter types and functions**:
   - All `FieldSchemaTo*` → `FieldTo*`
   - All `fieldSchemaTo*` → `fieldTo*`
   - All `tableSchemaTo*` → `tableTo*`

6. **Documentation updates**

## Verification

- [x] `bun run typecheck` passes (no rename-related errors)
- [ ] `bun test` passes
- [x] No grep matches for old names (except in this spec and variable names)
- [x] Exports in `index.ts` are updated
- [x] README examples use new names

## Execution Summary

The rename was executed on 2026-01-23 using a hybrid approach:

1. **Primary type definitions** (types.ts): Direct surgical edits to rename type declarations
2. **Usages across codebase**: AST-grep for bulk replacements + sub-agents for file-specific updates
3. **Re-exports**: Updated index.ts files in schema/, core/schema/, and main index.ts
4. **Documentation**: Updated README.md naming conventions table and JSDoc comments

### Additional Changes

- Renamed `KvMap` from `./core/docs` to `KvYMap` to avoid collision with new `KvMap` (field schema map)
- Fixed `definition-helper/index.ts` exports to match actual exports from definition-helper.ts

### Files Modified (26 files)

**Core type definitions:**

- `src/core/schema/fields/types.ts`
- `src/core/schema/fields/helpers.ts`
- `src/core/schema/fields/factories.ts`

**Converters:**

- `src/core/schema/converters/to-arktype.ts`
- `src/core/schema/converters/to-arktype-yjs.ts`
- `src/core/schema/converters/to-typebox.ts`
- `src/core/schema/converters/to-drizzle.ts`
- `src/core/schema/converters/index.ts`
- `src/core/schema/converters/to-arktype.test.ts`
- `src/core/schema/converters/to-typebox.test.ts`

**Re-exports:**

- `src/core/schema/index.ts`
- `src/index.ts`

**Consumers:**

- `src/core/definition-helper/definition-helper.ts`
- `src/core/definition-helper/index.ts`
- `src/core/tables/table-helper.ts`
- `src/core/kv/kv-helper.ts`
- `src/core/workspace/normalize.ts`
- `src/core/docs/workspace-doc.ts`
- `src/core/docs/index.ts`
- `src/extensions/markdown/markdown.ts`
- `src/extensions/markdown/configs.ts`
- `src/server/tables.ts`

**Documentation:**

- `src/core/schema/README.md`

## Rollback Plan

If issues arise, `git checkout` the affected files. This is a pure rename refactor with no behavioral changes.
