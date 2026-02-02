# Builder Pattern with Helper Functions

Epicenter uses a two-layer API strategy for serializers: a low-level builder pattern for maximum type inference, wrapped by high-level helper functions for common use cases. You get the best of both worlds.

## The Two Layers

### Layer 1: Builder Pattern (`defineSerializer`)

The builder pattern gives you full control and complete type inference:

```typescript
const customSerializer = defineSerializer<MySchema>()
  .parseFilename((filename: `${string}.md`) => {
    const id = path.basename(filename, '.md');
    return { id };
  })
  .serialize(({ row }) => ({
    frontmatter: { ...row },
    body: '',
    filename: `${row.id}.md`,
  }))
  .deserialize(({ parsed, frontmatter }) => {
    return Ok({ id: parsed.id, ...frontmatter });
  });
```

This is the foundation. Each step infers types that flow to the next step. See [Why Flow-Based APIs for Type Inference](./why-flow-based-apis-for-type-inference.md) for why this chaining is necessary.

### Layer 2: Helper Functions

For the 90% of cases where you don't need custom parsing logic, helper functions wrap the builder:

```typescript
// Instead of 15+ lines of builder code:
const serializer = bodyFieldSerializer('content');

// Or for title-based filenames:
const tabSerializer = titleFilenameSerializer('title');
```

These functions internally use `defineSerializer()` but hide the complexity.

## Why Two Layers?

### Builders Give You Type Narrowing

The builder pattern is the only way to get proper type inference when you have dependent types. TypeScript can't infer types across sibling properties in a config object, but it can infer types at sequential call sites.

When you call `.parseFilename()`, TypeScript captures:
- `TFilename` from the parameter type
- `TParsed` from the return type

These flow to `.serialize()` and `.deserialize()` automatically.

### Helper Functions Give You Simplicity

Most serializers follow predictable patterns:
- ID-based filenames (`{id}.md`)
- Title-based filenames (`{title}-{id}.md`)
- One field as the markdown body

Why make users write 15 lines of builder code for these common cases? Helper functions encapsulate the pattern:

```typescript
// bodyFieldSerializer internally does:
export function bodyFieldSerializer<TTableSchema extends TableSchema>(
  bodyField: keyof TTableSchema & string,
  options: BodyFieldSerializerOptions<TTableSchema> = {},
): MarkdownSerializer<TTableSchema> {
  return defineSerializer<TTableSchema>()
    .parseFilename((filename: `${string}.md`) => {
      const id = path.basename(filename, '.md');
      return { id };
    })
    .serialize(({ row }) => {
      const { [bodyField]: body, ...rest } = row;
      return {
        frontmatter: rest,
        body: (body as string) ?? '',
        filename: `${row.id}.md`,
      };
    })
    .deserialize(({ frontmatter, body, parsed, table }) => {
      // Validation and reconstruction logic
      return Ok({ id: parsed.id, [bodyField]: body, ...frontmatter });
    });
}
```

Users just write:

```typescript
{ serializer: bodyFieldSerializer('content') }
```

## Available Helper Functions

### `defaultSerializer()`

All fields go to frontmatter, empty body, `{id}.md` filename.

```typescript
markdownProvider(c, {
  tableConfigs: {
    settings: {},  // Uses defaultSerializer() implicitly
    config: { serializer: defaultSerializer() },  // Explicit
  }
})
```

### `bodyFieldSerializer(field)`

One field becomes the markdown body, rest goes to frontmatter.

```typescript
markdownProvider(c, {
  tableConfigs: {
    articles: { serializer: bodyFieldSerializer('content') },
    posts: { serializer: bodyFieldSerializer('markdown') },
  }
})
```

Options:
- `stripNulls`: Remove null values from frontmatter (default: `true`)
- `filenameField`: Which field to use for filename (default: `'id'`)

### `titleFilenameSerializer(field)`

Human-readable `{title}-{id}.md` filenames.

```typescript
markdownProvider(c, {
  tableConfigs: {
    tabs: { serializer: titleFilenameSerializer('title') },
    notes: { serializer: titleFilenameSerializer('name', { maxTitleLength: 50 }) },
  }
})
```

Options:
- `stripNulls`: Remove null values from frontmatter (default: `true`)
- `maxTitleLength`: Maximum characters for title portion (default: `80`)

## When to Use Each Layer

### Use Helper Functions When:

- Your serialization follows a standard pattern
- You don't need custom filename parsing
- You want minimal configuration

```typescript
// Simple cases - just use helpers
tableConfigs: {
  articles: { serializer: bodyFieldSerializer('content') },
  tabs: { serializer: titleFilenameSerializer('title') },
}
```

### Use the Builder When:

- You need custom filename patterns
- You need to parse extra data from filenames
- You need custom serialization logic (like the recipes example below)

```typescript
// Complex case: recipes with structured body sections
recipes: {
  serializer: defineSerializer<RecipeSchema>()
    .parseFilename((filename: `${string}.md`) => {
      return { id: path.basename(filename, '.md') };
    })
    .serialize(({ row }) => {
      const { id, ingredients, instructions, ...rest } = row;
      const body = `## Ingredients\n\n${ingredients}\n\n## Instructions\n\n${instructions}`;
      return { frontmatter: rest, body, filename: `${id}.md` };
    })
    .deserialize(({ frontmatter, body, parsed }) => {
      // Parse sections from body
      const ingredientsMatch = body.match(/## Ingredients\s*\n([\s\S]*?)(?=\n## Instructions|$)/);
      const instructionsMatch = body.match(/## Instructions\s*\n([\s\S]*?)$/);
      // ...
    }),
}
```

### Use Inline Serializer Objects When:

For one-off custom serializers where you don't need the builder's type inference (because you're defining everything explicitly anyway):

```typescript
// Inline object - simpler for custom cases
entries: {
  serializer: {
    serialize: ({ row }) => ({ ... }),
    deserialize: {
      parseFilename: (filename) => ({ id: path.basename(filename, '.md') }),
      fromContent: ({ frontmatter, body, parsed }) => { ... },
    },
  },
}
```

## The Pattern in Practice

Here's how Epicenter's example workspaces use both layers:

```typescript
// content-hub/journal - uses helper
journal: { serializer: bodyFieldSerializer('content', { stripNulls: false }) }

// content-hub/clippings - uses helpers for simple tables
articles: { serializer: bodyFieldSerializer('content') },
essays: { serializer: bodyFieldSerializer('content') },

// content-hub/clippings - uses inline object for complex case
recipes: {
  serializer: {
    serialize: ({ row }) => { /* custom section-based body */ },
    deserialize: {
      parseFilename: (filename) => { ... },
      fromContent: ({ body }) => { /* parse sections back out */ },
    },
  },
}

// content-hub/browser - uses helper
tabs: { serializer: titleFilenameSerializer('title') }
```

## Summary

| Layer | Use Case | Type Inference | Complexity |
|-------|----------|----------------|------------|
| Helper functions | Standard patterns | Automatic | Minimal |
| Builder pattern | Custom logic | Full control | Medium |
| Inline objects | One-off customs | Manual | Varies |

The two-layer approach means you don't have to choose between type safety and usability. Helper functions handle the common cases with zero boilerplate. The builder is there when you need it. And inline objects work for truly custom scenarios.

Start with helper functions. Reach for the builder when you need more control.
