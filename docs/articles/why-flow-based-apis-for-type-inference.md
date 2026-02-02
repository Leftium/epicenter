# Why Flow-Based APIs for Type Inference

When you need multiple functions that share type information, TypeScript's inference has a fundamental limitation: it can't infer types from one property of an object and apply them to sibling properties in the same object literal.

This is why Epicenter uses flow-based (chained) APIs for serializers instead of a single configuration object.

## The Problem: Dependent Type Inference

Consider what a markdown serializer needs:

1. **`parseFilename`** - Takes a filename pattern, returns parsed data
2. **`serialize`** - Must return a filename matching that same pattern
3. **`deserialize`** - Receives the parsed data from step 1

The types flow like this:

```
parseFilename: (filename: TFilename) => TParsed
                    ↓                      ↓
serialize: (...) => { filename: TFilename }
                                           ↓
deserialize: ({ parsed: TParsed }) => Row
```

`TFilename` and `TParsed` need to be inferred from `parseFilename`, then enforced on the other two functions.

## You Might Think: "Just Use a Config Object"

The intuitive approach looks like this:

```typescript
// Seems reasonable, right?
defineSerializer<MySchema>({
  parseFilename: (filename: `${string}.md`) => {
    const id = path.basename(filename, '.md');
    return { id };
  },
  serialize: ({ row }) => ({
    frontmatter: { ...row },
    body: '',
    filename: `${row.id}.md`,  // Should be constrained to `${string}.md`
  }),
  deserialize: ({ parsed }) => {
    // parsed.id should be typed as string
    return Ok({ id: parsed.id, ...frontmatter });
  },
});
```

This feels natural. All configuration in one place. No "strange" chaining.

**The problem: TypeScript can't make this work.**

## Why Config Objects Fail

When TypeScript analyzes an object literal, it processes all properties together. It can't:

1. Infer `TFilename = \`${string}.md\`` from `parseFilename`'s parameter
2. Then apply that to constrain `serialize`'s return type
3. Infer `TParsed = { id: string }` from `parseFilename`'s return
4. Then apply that to type `deserialize`'s `parsed` parameter

The type checker sees the whole object at once. There's no "first infer this, then use it there" flow.

### What Would You Have to Write?

To make a config object work, you'd need explicit type parameters:

```typescript
defineSerializer<
  MySchema,              // The table schema
  `${string}.md`,        // TFilename - manually specified
  { id: string }         // TParsed - manually specified
>({
  parseFilename: (filename) => ({ id: path.basename(filename, '.md') }),
  serialize: ({ row }) => ({ ... }),
  deserialize: ({ parsed }) => { ... },
});
```

That defeats the purpose. You're writing types that should be inferred.

### The Type Definition Would Be Impossible

Here's what the type would need to look like:

```typescript
type SerializerConfig<
  TTableSchema extends TableSchema,
  TFilename extends string,
  TParsed extends ParsedFilename
> = {
  parseFilename: (filename: TFilename) => TParsed | undefined;
  serialize: (params: { row: SerializedRow<TTableSchema> }) => {
    frontmatter: Record<string, unknown>;
    body: string;
    filename: TFilename;  // Must match parseFilename's input
  };
  deserialize: (params: {
    parsed: TParsed;      // Must match parseFilename's output
    // ...
  }) => Result<SerializedRow<TTableSchema>, Error>;
};
```

TypeScript has no way to say "infer `TFilename` from the `parseFilename` property's parameter type and `TParsed` from its return type, then use those in the other properties."

## How Flow-Based APIs Solve This

Method chaining creates sequential inference points:

```typescript
defineSerializer<MySchema>()
  .parseFilename((filename: `${string}.md`) => {
    const id = path.basename(filename, '.md');
    return { id };
  })
  // TypeScript NOW knows:
  //   TFilename = `${string}.md`
  //   TParsed = { id: string }
  .serialize(({ row }) => ({
    frontmatter: { ...row },
    body: '',
    filename: `${row.id}.md`,  // Constrained to TFilename
  }))
  .deserialize(({ parsed }) => {
    // parsed is typed as { id: string }
    return Ok({ id: parsed.id, ...frontmatter });
  });
```

### Why This Works

Each method returns a new builder type that captures the inferred types:

```typescript
// Step 1: Start with just the table schema
defineSerializer<MySchema>()
// Returns: SerializerBuilder<MySchema>

// Step 2: Define parseFilename
.parseFilename((filename: `${string}.md`) => ({ id: '...' }))
// Returns: SerializerBuilderWithParser<MySchema, `${string}.md`, { id: string }>
//          ↑ TFilename captured        ↑ TParsed captured

// Step 3: Define serialize (TFilename is now available)
.serialize(({ row }) => ({ filename: `${row.id}.md`, ... }))
// Returns: SerializerBuilderWithSerialize<MySchema, `${string}.md`, { id: string }>

// Step 4: Define deserialize (TParsed is now available)
.deserialize(({ parsed }) => { ... })
// Returns: MarkdownSerializer<MySchema, { id: string }>
```

The key insight: **TypeScript infers types at call sites**. Each `.method()` call is a call site where inference happens. The return type carries those inferred types to the next call.

## Real-World Example: Title-Based Filenames

Here's a more complex case that shows the power of flow-based inference:

```typescript
const titleSerializer = defineSerializer<TabSchema>()
  .parseFilename((filename: `${string}-${string}.md`) => {
    const basename = path.basename(filename, '.md');
    const lastDash = basename.lastIndexOf('-');
    return {
      id: basename.substring(lastDash + 1),
      titleFromFilename: basename.substring(0, lastDash),
    };
  })
  .serialize(({ row }) => ({
    frontmatter: { ...row },
    body: '',
    filename: `${row.title}-${row.id}.md`,
  }))
  .deserialize(({ parsed }) => {
    // parsed.id: string
    // parsed.titleFromFilename: string  <- Fully typed!
    console.log(`Title from filename: ${parsed.titleFromFilename}`);
    return Ok({ id: parsed.id, ... });
  });
```

The `titleFromFilename` field is automatically typed in `deserialize` because TypeScript inferred it from `parseFilename`'s return type.

With a config object, you'd have to manually specify `{ id: string; titleFromFilename: string }` as a type parameter.

## Industry Precedent

This isn't unique to Epicenter. The same pattern appears in:

- **tRPC**: `.input(z.string()).query(({ input }) => ...)` - input type flows to handler
- **Zod**: `.transform(s => s.toUpperCase()).refine(...)` - transformed type flows forward
- **Drizzle**: `.select().from(users).where(...)` - table types constrain where clauses

These libraries all discovered the same thing: when you need dependent type inference across multiple functions, method chaining is the only way to make it work without explicit type annotations.

## Summary

| Approach | Type Inference | Ergonomics |
|----------|----------------|------------|
| Config object | Requires explicit type params | Single call, all at once |
| Flow-based API | Fully automatic | Method chaining |

The flow-based API trades a slightly different syntax (chaining instead of object literal) for automatic type inference. Given that the whole point is type safety, this trade-off makes sense.

When you see `.parseFilename().serialize().deserialize()` in Epicenter, you're not looking at arbitrary API design. You're looking at the only way to make TypeScript infer dependent types across multiple functions.
