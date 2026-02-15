# JsonColumnSchema Standard Schema Migration

**Created**: 2025-12-31T16:00:00
**Status**: In Progress

## Problem

`JsonColumnSchema` currently requires ArkType's `Type`:

```typescript
export type JsonColumnSchema<
	TSchema extends Type = Type, // ← ArkType-specific
	TNullable extends boolean = boolean,
> = {
	type: 'json';
	nullable: TNullable;
	schema: TSchema;
	default?: TSchema['infer']; // ← ArkType-specific
};
```

This couples the schema system to ArkType. We want library-agnostic schemas that work with Zod, Valibot, or any Standard Schema compliant library.

## Solution

Change `JsonColumnSchema` to use `CombinedStandardSchema` (combined interface that provides both validation and JSON Schema generation):

```typescript
export type JsonColumnSchema<
	TSchema extends CombinedStandardSchema = CombinedStandardSchema,
	TNullable extends boolean = boolean,
> = {
	type: 'json';
	nullable: TNullable;
	schema: TSchema;
	default?: StandardSchemaV1.InferOutput<TSchema>;
};
```

## Changes Required

### 1. Create shared type (schema/standard-schema.ts)

- [ ] Move `CombinedStandardSchema` from `actions.ts` to schema module
- [ ] Export from schema index

### 2. Update types.ts

- [ ] Import `CombinedStandardSchema` and `StandardSchemaV1`
- [ ] Change `TSchema extends Type` to `TSchema extends CombinedStandardSchema`
- [ ] Change `TSchema['infer']` to `StandardSchemaV1.InferOutput<TSchema>`

### 3. Update columns.ts

- [ ] Update `json()` function signature to use new constraint
- [ ] Remove ArkType `Type` import if no longer needed

### 4. Update converters

- [ ] `arktype.ts`: Already uses `StandardSchemaV1.InferOutput` - just verify
- [ ] `arktype-yjs.ts`: Change `TSchema['infer']` to `StandardSchemaV1.InferOutput<TSchema>`
- [ ] `drizzle.ts`: Change `TSchema['infer']` to `StandardSchemaV1.InferOutput<TSchema>`

### 5. Validation pattern

- [ ] `arktype.ts` line 179: `columnSchema.schema` is used as arktype Type directly
  - This still works because ArkType's Type satisfies CombinedStandardSchema
  - The validation uses it as a callable, which is ArkType-specific
  - For now, keep using the schema directly since ArkType is the implementation

## Success Criteria

- [ ] `JsonColumnSchema` accepts any `CombinedStandardSchema` compliant schema
- [ ] Type inference works via `StandardSchemaV1.InferOutput`
- [ ] Existing ArkType usage continues to work (ArkType implements the spec)
- [ ] TypeScript compiles without errors
- [ ] Existing tests pass

## Out of Scope

- Replacing `instanceof type.errors` validation pattern (broader refactor)
- Supporting non-ArkType libraries at runtime (would need adapter layer)

## Notes

ArkType's `Type` already satisfies both `StandardSchemaV1` and `StandardJSONSchemaV1`:

```typescript
type('string') satisfies StandardJSONSchemaV1; // ✅
```

So this change is primarily about the type constraint, not runtime behavior.
