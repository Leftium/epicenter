# When to Remove Default Generics: The Pass-Through Type Pattern

Default generic parameters in TypeScript can silently mask bugs by allowing call sites to omit type arguments that should flow through the entire call chain.

## The Problem

Consider a type used as an intermediate in generic function signatures:

```typescript
// Type with defaults
type CapabilityContext<
	TTableDefinitionMap extends TableDefinitionMap = TableDefinitionMap,
	TKvSchema extends KvSchema = KvSchema,
> = {
	tables: Tables<TTableDefinitionMap>;
	kv: Kv<TKvSchema>;
};
```

When a capability function uses this type, it's easy to forget the second generic:

```typescript
// Bug: TKvSchema defaults to KvSchema, breaking type inference chain
export const sqlite = async <TTableDefinitionMap extends TableDefinitionMap>(
  context: CapabilityContext<TTableDefinitionMap>,  // Missing TKvSchema!
  config: SqliteConfig,
) => { ... }
```

This compiles without errors because `TKvSchema` defaults to `KvSchema`. But the specific KV schema type information from the workspace definition is silently lost.

## The Pattern: Pass-Through Types

A "pass-through type" is one that:

1. Is always used within another generic function signature
2. Should receive its generic parameters from the outer function
3. Is never instantiated standalone with concrete types

```typescript
// Pass-through: always inside another generic function
function capability<TSchema, TKv>(
  context: CapabilityContext<TSchema, TKv>  // Pass-through usage
) { ... }

// NOT pass-through: used standalone with concrete types
const ctx: CapabilityContext<MySchema, MyKv> = ...;  // Direct usage
```

## The Solution: Remove Defaults from Pass-Through Types

For types that should always receive their generics from an outer scope, remove the defaults:

```typescript
// No defaults - forces explicit type parameters
type CapabilityContext<
	TTableDefinitionMap extends TableDefinitionMap,
	TKvSchema extends KvSchema,
> = {
	tables: Tables<TTableDefinitionMap>;
	kv: Kv<TKvSchema>;
};
```

Now the buggy code fails to compile:

```typescript
// Error: Generic type 'CapabilityContext' requires 2 type argument(s)
export const sqlite = async <TTableDefinitionMap extends TableDefinitionMap>(
  context: CapabilityContext<TTableDefinitionMap>,  // Compile error!
  config: SqliteConfig,
) => { ... }
```

Forcing the fix:

```typescript
// Correct: Both generics passed through
export const sqlite = async <
  TTableDefinitionMap extends TableDefinitionMap,
  TKvSchema extends KvSchema,
>(
  context: CapabilityContext<TTableDefinitionMap, TKvSchema>,
  config: SqliteConfig,
) => { ... }
```

## When to Keep Defaults

Keep default generic parameters when:

1. **Standalone usage is common**: The type is frequently used with concrete types, not just as pass-through
2. **Sensible base type exists**: The default represents a meaningful "any" case
3. **Return types**: Generic return types often benefit from defaults for inference

```typescript
// Good use of defaults - commonly used standalone
type Result<T = unknown, E = Error> = { ok: true; value: T } | { ok: false; error: E };

// Consumer can omit types when they don't care
function handleResult(result: Result) { ... }
```

## When to Remove Defaults

Remove default generic parameters when:

1. **Type is always intermediate**: Only used as a parameter type in other generic functions
2. **Type chain must be preserved**: The generic represents specific schema/config that shouldn't be lost
3. **Accidental omission is a bug**: Forgetting the generic parameter indicates a real error

## Real Example: Capability System

In a capability system where contexts flow workspace schemas to capability functions:

```typescript
// Workspace defines specific schemas
const workspace = defineWorkspace({
	tables: { posts: { fields: { id: id(), title: text() } } },
	kv: { theme: text() },
});

// Capability receives context with those schemas
workspace.create({
	capabilities: {
		// The capability MUST receive the full schema types
		// Defaults would silently lose type information
		sqlite: (ctx) => sqlite(ctx, config),
	},
});
```

Without defaults on `CapabilityContext`, TypeScript ensures every capability properly declares and passes through both `TTableDefinitionMap` and `TKvSchema`.

## Summary

| Scenario                                   | Default Generics |
| ------------------------------------------ | ---------------- |
| Pass-through type in generic chains        | Remove defaults  |
| Standalone type with sensible base         | Keep defaults    |
| Schema/config types that must flow through | Remove defaults  |
| Utility types with "any" semantics         | Keep defaults    |

The key question: "If someone forgets this generic parameter, is that always a bug?" If yes, remove the default.
