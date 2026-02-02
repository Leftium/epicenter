# Why We Prefix TypeScript Generics with T

**TL;DR**: The `T` prefix for generics (`TWorkspace`, `TTables`) isn't Hungarian notation; it solves a real problem. When you write `TWorkspace extends Workspace`, both types exist and are closely related but serve different purposes. The `T` makes this relationship obvious at a glance.

---

## The Problem: Generics Hide in Plain Sight

You're reading a type definition with five type references:

```typescript
type ProviderContext<Schema, Exports, Config, Paths, Tables> = {
	schema: Schema;
	exports: Exports;
	config: Config;
	paths: Paths;
	tables: Tables;
};
```

Quick: which of these are generics and which are imported types?

You can't tell. They're all PascalCase. You have to scroll up to the generic parameter list or hover in your IDE. In a complex type with 10+ references, this becomes cognitive overhead that accumulates.

Now compare:

```typescript
type ProviderContext<TSchema, TExports, TConfig, TPaths, TTables> = {
	schema: TSchema;
	exports: TExports;
	config: TConfig;
	paths: TPaths;
	tables: TTables;
};
```

The `T` prefix tells you immediately: these are the generic parameters I'm working with.

## "But That's Just Hungarian Notation"

It's not. Here's why the comparison fails.

Hungarian notation prefixes variables with their type:

```typescript
// Hungarian notation (don't do this)
const strName = 'Alice';
const intCount = 42;
const boolActive = true;
```

The problem with Hungarian notation is that the prefix adds no information. There's no `Name` that exists alongside `strName`. The compiler already knows `strName` is a string. The prefix is redundant noise.

The `T` prefix is fundamentally different because **both types actually exist**:

```typescript
// Real scenario: both Workspace and TWorkspace exist
type Workspace = { id: string; tables: TablesSchema };

type ProviderContext<TWorkspace extends Workspace> = {
	workspace: TWorkspace; // The specific workspace (generic)
	base: Workspace; // The base type (concrete)
};
```

`TWorkspace` and `Workspace` are two different things:

- `Workspace` is the base type (what any workspace must have)
- `TWorkspace` is the specific workspace being used (could be `BlogWorkspace`, `NotesWorkspace`, etc.)

The `T` prefix signals: "this is the generic version of that base type."

## The Hierarchical Relationship

The pattern is almost always `TFoo extends Foo`:

```typescript
// The generic extends a base type of the same name
type Handler<TSchema extends TableSchema> = (row: Row<TSchema>) => void;

type Client<TTables extends TablesSchema> = {
	tables: Tables<TTables>;
};

type Validator<TInput extends StandardSchema> = (input: TInput) => boolean;
```

Without the prefix, you'd write:

```typescript
type Handler<Schema extends TableSchema> = (row: Row<Schema>) => void;
```

Now `Schema` and `TableSchema` look like siblings when they're actually in a parent-child relationship. The `T` prefix makes the hierarchy visible:

```typescript
type Handler<TSchema extends TableSchema> = (row: Row<TSchema>) => void;
//           ↑ "T" signals: this is a specific variant of the base type
```

## When the Prefix Prevents Bugs

Consider a function that takes both a base type and a generic:

```typescript
// Without T prefix - easy to mix up
function createValidator<Schema extends TableSchema>(
	baseSchema: TableSchema,
	specificSchema: Schema,
): Validator<Schema>;

// With T prefix - roles are clear
function createValidator<TSchema extends TableSchema>(
	baseSchema: TableSchema,
	specificSchema: TSchema,
): Validator<TSchema>;
```

In the first version, `Schema` and `TableSchema` look interchangeable. In the second, `TSchema` is obviously the generic parameter while `TableSchema` is the concrete base.

## Convention Across the Ecosystem

Matt Pocock (TypeScript educator) recommends the `T` prefix for this exact reason. The TypeScript compiler itself uses it internally. Microsoft's style guides suggest it.

The convention has near-universal adoption:

```typescript
// React
type ComponentProps<TElement extends Element> = { ... };

// Standard library
interface Map<TKey, TValue> { ... }

// Zod
type ZodType<TOutput, TDef, TInput> = { ... };
```

## Exceptions: When T Isn't Needed

Skip the prefix when:

1. **Single-letter generics are sufficient**: `Array<T>`, `Promise<T>`. When there's only one generic and context is obvious, `T` alone is fine.

2. **The generic isn't constrained by a type of the same name**: If you have `<K extends string>`, there's no `K` type to confuse it with.

3. **Library conventions differ**: Match the codebase you're in. Consistency beats personal preference.

## The Rule

**Use `T` prefix when the generic extends a type of similar name:**

```typescript
// Yes - TWorkspace extends Workspace
type Context<TWorkspace extends Workspace> = { ... };

// Yes - TTables extends TablesSchema
type Client<TTables extends TablesSchema> = { ... };

// Not necessary - no "Key" type to confuse with
type Record<K extends string, V> = { ... };

// Not necessary - single generic, context is clear
type Array<T> = { ... };
```

The `T` prefix exists because TypeScript generics and their base types share the same namespace and naming conventions. When both exist, the prefix makes the distinction visible without IDE assistance.

That's not ceremony. That's clarity.
