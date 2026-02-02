# TypeBox Converter Implementation

**Created**: 2026-01-07T19:55:00
**Status**: In Progress

## Overview

Add a `to-typebox.ts` converter that transforms FieldDefinition definitions into TypeBox schemas. TypeBox schemas can be compiled to highly optimized JIT validators, offering significant performance benefits over runtime validation.

## Background

### Why TypeBox?

TypeBox creates JSON Schema objects that can be compiled to validators using Just-In-Time (JIT) code generation. Key benefits:

- Fastest validation in benchmarks
- Pure JSON Schema output (compatible with Ajv, OpenAPI)
- `Type.Refine()` for custom validation predicates

### TypeBox API Surface

| TypeBox                    | Description       |
| -------------------------- | ----------------- |
| `Type.String()`            | String type       |
| `Type.Number()`            | Floating point    |
| `Type.Integer()`           | Whole numbers     |
| `Type.Boolean()`           | Boolean           |
| `Type.Null()`              | Null literal      |
| `Type.Union([A, B])`       | Union types       |
| `Type.Array(T)`            | Arrays            |
| `Type.Literal('value')`    | Exact literal     |
| `Type.Object({...})`       | Object schemas    |
| `Type.Optional(T)`         | Optional field    |
| `Type.Refine(T, fn, opts)` | Custom validation |
| `{ default: value }`       | Default values    |
| `{ pattern: regex }`       | String pattern    |

### Standard Schema Validation API

```typescript
const result = schema['~standard'].validate(value);
// Success: result.issues is undefined/falsy
// Failure: result.issues is array of Issue objects
if (result.issues) {
	// validation failed
}
// result.value contains the validated output
```

## Field Definition to TypeBox Mapping

| FieldDefinition | TypeBox Equivalent                                                     |
| --------------- | ---------------------------------------------------------------------- |
| `id`            | `Type.String()`                                                        |
| `text`          | `Type.String()` + nullable handling                                    |
| `richtext`      | `Type.Union([Type.String(), Type.Null()])` (always nullable)           |
| `integer`       | `Type.Integer()` + nullable handling                                   |
| `real`          | `Type.Number()` + nullable handling                                    |
| `boolean`       | `Type.Boolean()` + nullable handling                                   |
| `date`          | `Type.String({ pattern: DATE_TIME_STRING_REGEX.source })`              |
| `select`        | `Type.Union([Type.Literal('opt1'), ...])`                              |
| `tags`          | `Type.Array(Type.Union([...literals]))` or `Type.Array(Type.String())` |
| `json`          | `Type.Refine(Type.Unknown(), standardSchemaValidate)`                  |

### Nullable Handling

For nullable fields, wrap the base type in a union:

```typescript
Type.Union([baseType, Type.Null()]);
```

### JSON Field Handling

Since JSON fields embed StandardSchema (arktype, zod, etc.) and TypeBox doesn't natively support StandardSchema, use `Type.Refine`:

```typescript
Type.Refine(
	Type.Unknown(),
	(value) => {
		const result = jsonFieldDefinition.schema['~standard'].validate(value);
		if (result instanceof Promise) return false; // async not supported
		return !result.issues;
	},
	{ message: 'JSON validation failed' },
);
```

## Implementation

### Files to Create/Modify

1. `packages/epicenter/src/core/schema/converters/to-typebox.ts` - Main converter
2. `packages/epicenter/src/core/schema/converters/to-typebox.test.ts` - Tests
3. `packages/epicenter/src/core/schema/converters/index.ts` - Add exports

### API Design

```typescript
// Type mapping
export type FieldDefinitionToTypebox<C extends FieldDefinition> = TSchema;

// Convert single field
export function fieldDefinitionToTypebox<C extends FieldDefinition>(
	fieldDefinition: C,
): FieldDefinitionToTypebox<C>;

// Convert table schema to TypeBox object
export function fieldsDefinitionToTypebox<
	TFieldDefinitions extends FieldDefinitions,
>(fieldsDefinition: TFieldDefinitions): TObject;
```

## Todo

- [x] Create `to-typebox.ts` with converter functions
- [x] Create `to-typebox.test.ts` with tests
- [x] Update `converters/index.ts` exports
- [x] Verify with build/typecheck

## Review

### Implementation Summary

Created `to-typebox.ts` converter that transforms FieldDefinition definitions into TypeBox TSchema objects. The implementation follows the same pattern as the existing `to-arktype.ts` converter.

### Files Created/Modified

1. **`packages/epicenter/src/core/schema/converters/to-typebox.ts`** - Main converter with:
   - `FieldDefinitionToTypebox<C>` type mapping
   - `fieldDefinitionToTypebox()` - single field conversion
   - `fieldsDefinitionToTypebox()` - full table conversion

2. **`packages/epicenter/src/core/schema/converters/to-typebox.test.ts`** - 16 tests covering all field types

3. **`packages/epicenter/src/core/schema/converters/index.ts`** - Added exports

4. **`packages/epicenter/package.json`** - Added `typebox` dependency (note: use `typebox`, not the deprecated `@sinclair/typebox`)

### Key Design Decisions

1. **TypeBox 1.x** - Use `typebox` package (not `@sinclair/typebox` which is deprecated)
2. **JSON fields use `Type.Unknown()`** - TypeBox acts as pass-through; the embedded StandardSchema validates at usage time (sqlite provider, handlers). When TypeBox 1.0 releases, `Type.Refine` can be used for inline validation.
3. **Nullable handling** - Uses `Type.Union([baseType, Type.Null()])`
4. **Select fields** - Uses `Type.Union([Type.Literal(...), ...])`
5. **Integer vs Real** - Uses `Type.Integer()` for integers (rejects floats), `Type.Number()` for reals

### Test Results

All 16 tests pass covering: id, text, integer, real, boolean, select, tags (with/without options), json, and nullable variants.
