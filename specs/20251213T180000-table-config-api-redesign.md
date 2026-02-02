# TableMarkdownConfig API Redesign

## Overview

This document specifies a redesign of the `TableMarkdownConfig` type in the markdown provider. The goal is to create cleaner separation between concerns and better naming.

## Current State

The current `TableMarkdownConfig` has a flat structure mixing location and serialization concerns:

```typescript
type TableMarkdownConfig<TTableSchema, TParsed> = {
  directory?: string;
  serialize: SerializeFn<TTableSchema>;
  parseFilename: ParseFilenameFn<TParsed>;
  deserialize: DeserializeFn<TTableSchema, TParsed>;
};
```

### Problems with Current Design

1. **Mixed concerns**: `directory` (location) is mixed with serialization functions
2. **Flat structure obscures relationships**: `parseFilename` and `deserialize` are both part of "decoding" but appear as siblings to `serialize`
3. **Awkward factory functions**: Functions like `withBodyField()` couple directory with serialization
4. **Spread + transform pattern**: The provider does special resolution on `directory` while other fields pass through

## Proposed Design

### New Type Structure

```typescript
/**
 * A serializer defines how to encode rows to markdown files and decode them back.
 */
type MarkdownSerializer<
  TTableSchema extends TableSchema,
  TParsed extends ParsedFilename = ParsedFilename,
> = {
  /**
   * Encode: Convert a row to markdown file format.
   * Returns frontmatter object, body string, and filename.
   */
  serialize: (params: {
    row: SerializedRow<TTableSchema>;
    table: TableHelper<TTableSchema>;
  }) => {
    frontmatter: Record<string, unknown>;
    body: string;
    filename: string;
  };

  /**
   * Decode: Convert markdown file back to a row.
   * Two-step process: parse filename first, then parse content.
   */
  deserialize: {
    /**
     * Step 1: Extract structured data from filename.
     * Must return at least { id }, can include additional fields.
     * Return undefined if filename doesn't match expected pattern.
     */
    parseFilename: (filename: string) => TParsed | undefined;

    /**
     * Step 2: Reconstruct the row from frontmatter, body, and parsed filename data.
     * Called only if parseFilename succeeded.
     */
    fromContent: (params: {
      frontmatter: Record<string, unknown>;
      body: string;
      filename: string;
      parsed: TParsed;
      table: TableHelper<TTableSchema>;
    }) => Result<SerializedRow<TTableSchema>, MarkdownProviderError>;
  };
};

/**
 * Configuration for how a table syncs to markdown files.
 * Both fields are optional with sensible defaults.
 */
type TableMarkdownConfig<
  TTableSchema extends TableSchema,
  TParsed extends ParsedFilename = ParsedFilename,
> = {
  /**
   * WHERE files go. Resolved relative to workspace directory.
   * @default table.name (e.g., "posts" table -> "./posts/")
   */
  directory?: string;

  /**
   * HOW files are encoded/decoded.
   * @default Default serializer (all fields to frontmatter, {id}.md filename)
   */
  serializer?: MarkdownSerializer<TTableSchema, TParsed>;
};
```

### Key Design Decisions

1. **Two top-level keys**: `directory` and `serializer` - clean separation of WHERE vs HOW
2. **Both optional**: Sensible defaults for both (table name for directory, all-frontmatter for serializer)
3. **Nested `deserialize`**: Groups the two decode steps (`parseFilename` + `fromContent`) together
4. **Asymmetric structure**: `serialize` is one function, `deserialize` is an object with two functions - this reflects reality (encoding is one step, decoding is two steps)

### Why `deserialize` is Nested

The deserialization flow has two distinct steps:

```
File: "hello-world-abc123.md"
         │
         ▼
Step 1: deserialize.parseFilename("hello-world-abc123.md")
         → { id: 'abc123', titleFromFilename: 'hello-world' }
         │
         ▼ (only if step 1 succeeds)
Step 2: deserialize.fromContent({ frontmatter, body, parsed, ... })
         → Result<Row>
```

**Why separate?**
- **Fail-fast**: Invalid filename pattern → skip file before reading contents
- **Type flow**: `TParsed` (parseFilename's return) flows to `fromContent`'s `parsed` parameter
- **Different error handling**: Filename parse failure vs content validation failure

## Factory Functions

### Serializer Factories (return `MarkdownSerializer`)

```typescript
/**
 * Default serializer: all fields to frontmatter, {id}.md filename.
 */
export function defaultSerializer<TTableSchema>(): MarkdownSerializer<TTableSchema>;

/**
 * Body field serializer: one field becomes markdown body.
 */
export function bodyFieldSerializer<TTableSchema>(
  bodyField: keyof TTableSchema & string,
  options?: {
    stripNulls?: boolean;
    filenameField?: keyof TTableSchema & string;
  }
): MarkdownSerializer<TTableSchema>;

/**
 * Title filename serializer: {title}-{id}.md filename pattern.
 */
export function titleFilenameSerializer<TTableSchema>(
  titleField: keyof TTableSchema & string,
  options?: {
    stripNulls?: boolean;
    maxTitleLength?: number;
  }
): MarkdownSerializer<TTableSchema>;
```

### Removed Functions

The following convenience wrappers are **removed** in favor of explicit `{ serializer: ..., directory: ... }`:

- `withBodyField()` - use `{ serializer: bodyFieldSerializer('content') }`
- `withTitleFilename()` - use `{ serializer: titleFilenameSerializer('title') }`
- `defaultTableConfig()` - use `{}` (empty object) or `{ directory: '...' }`

## Usage Examples

### Basic Usage

```typescript
markdownProvider(c, {
  tableConfigs: {
    // Both defaults (empty object)
    settings: {},

    // Custom directory only
    config: { directory: './app-config' },

    // Custom serializer only
    posts: { serializer: bodyFieldSerializer('content') },

    // Both custom
    drafts: {
      directory: './drafts',
      serializer: bodyFieldSerializer('content'),
    },

    // Title-based filenames
    tabs: { serializer: titleFilenameSerializer('title') },
  }
})
```

### Single-Table Workspace (files at workspace root)

```typescript
// Files at ./journal/*.md (not ./journal/journal/*.md)
markdownProvider(c, {
  directory: './journal',
  tableConfigs: {
    entries: {
      directory: '.',  // Files at workspace root
      serializer: bodyFieldSerializer('content'),
    }
  }
})
```

### Custom Serializer

```typescript
markdownProvider(c, {
  tableConfigs: {
    recipes: {
      serializer: {
        serialize: ({ row }) => ({
          frontmatter: { title: row.title, tags: row.tags },
          body: row.instructions,
          filename: `${row.slug}.md`,
        }),
        deserialize: {
          parseFilename: (filename) => {
            const slug = path.basename(filename, '.md');
            return { id: slug, slug };
          },
          fromContent: ({ frontmatter, body, parsed, table }) => {
            // Validate and reconstruct row
            const row = {
              id: parsed.id,
              slug: parsed.slug,
              title: frontmatter.title,
              tags: frontmatter.tags,
              instructions: body,
            };
            return Ok(row);
          },
        },
      },
    },
  },
})
```

## Provider Resolution Logic

```typescript
const tableWithConfigs = tables.$tables().map((table) => {
  const userConfig = userTableConfigs[table.name] ?? {};

  // Resolve serializer: user-provided or default
  const serializer = userConfig.serializer ?? defaultSerializer();

  // Resolve directory: user-provided or table name
  const directory = path.resolve(
    absoluteWorkspaceDir,
    userConfig.directory ?? table.name,
  ) as AbsolutePath;

  // Flatten for internal use
  return {
    table,
    tableConfig: {
      directory,
      serialize: serializer.serialize,
      parseFilename: serializer.deserialize.parseFilename,
      deserialize: serializer.deserialize.fromContent,
    }
  };
});
```

## Builder Pattern Changes

The existing builder pattern (`defineTableConfig().withParser().withSerializers()`) should be updated:

```typescript
// New builder API
defineTableConfig<TTableSchema>()
  .withSerializer({
    serialize: ({ row }) => ({ frontmatter, body, filename }),
    deserialize: {
      parseFilename: (filename) => ({ id }),
      fromContent: ({ frontmatter, body, parsed }) => Ok(row),
    },
  });

// Or with separate steps for type inference
defineTableConfig<TTableSchema>()
  .withFilenameParser((filename) => ({ id, ...metadata }))
  .withSerialize(({ row }) => ({ frontmatter, body, filename }))
  .withDeserialize(({ frontmatter, body, parsed }) => Ok(row));
```

## Files to Modify

1. **`packages/epicenter/src/providers/markdown/configs.ts`**
   - Add `MarkdownSerializer` type
   - Update `TableMarkdownConfig` type
   - Create `defaultSerializer()`, `bodyFieldSerializer()`, `titleFilenameSerializer()`
   - Update/remove `defineTableConfig` builder
   - Remove `withBodyField()`, `withTitleFilename()`, `defaultTableConfig()`

2. **`packages/epicenter/src/providers/markdown/markdown-provider.ts`**
   - Update config resolution logic
   - Update all places that call `serialize`, `parseFilename`, `deserialize`
   - Update re-exports

3. **`packages/epicenter/src/providers/markdown/index.ts`**
   - Update exports (new factory functions, types)

## Migration Guide

### Before

```typescript
tableConfigs: {
  posts: withBodyField('content'),
  drafts: withBodyField('content', { directory: './drafts' }),
  settings: defaultTableConfig(),
  config: defaultTableConfig({ directory: './app-config' }),
}
```

### After

```typescript
tableConfigs: {
  posts: { serializer: bodyFieldSerializer('content') },
  drafts: { serializer: bodyFieldSerializer('content'), directory: './drafts' },
  settings: {},
  config: { directory: './app-config' },
}
```

## Open Questions

1. **Naming**: Is `serializer` the best name? Alternatives: `codec`, `format`, `serde`
2. **`fromContent` naming**: Is this clear? Alternatives: `parse`, `reconstruct`, `toRow`
3. **Builder pattern**: Keep, simplify, or remove entirely?

## Implementation Review

### Summary

Implemented the full API redesign as specified. The key changes:

1. **New `MarkdownSerializer` type**: Defines `serialize` and nested `deserialize: { parseFilename, fromContent }` structure
2. **New `TableMarkdownConfig` type**: Now has just `directory?` and `serializer?` fields
3. **New `defineSerializer()` builder**: Provides full type inference for custom serializers with bidirectional type flow
4. **New serializer factories** (all built with the builder):
   - `defaultSerializer()`: All fields to frontmatter, `{id}.md` filename
   - `bodyFieldSerializer(field, options?)`: One field becomes markdown body
   - `titleFilenameSerializer(field, options?)`: Human-readable `{title}-{id}.md` filenames
5. **Provider config resolution**: Extracts nested serializer functions into flat internal structure
6. **Legacy exports preserved**: `withBodyField`, `withTitleFilename`, `defaultTableConfig` marked as deprecated but still functional for backwards compatibility

### Files Modified

1. `packages/epicenter/src/providers/markdown/configs.ts` - Complete rewrite with new types and serializer factories
2. `packages/epicenter/src/providers/markdown/markdown-provider.ts` - Updated config resolution, imports, and exports
3. `packages/epicenter/src/providers/markdown/index.ts` - Updated exports
4. `examples/content-hub/browser/browser.workspace.ts` - Migrated to new API
5. `examples/content-hub/wiki/wiki.workspace.ts` - Migrated to new API (including custom inline serializer)
6. `examples/content-hub/clippings/clippings.workspace.ts` - Migrated to new API (including custom recipes serializer)
7. `examples/content-hub/journal/journal.workspace.ts` - Migrated to new API
8. `examples/content-hub/wiki/README.md` - Updated documentation reference

### Migration Examples

```typescript
// Before
tabs: withTitleFilename('title')
posts: withBodyField('content', { directory: './blog' })
settings: defaultTableConfig()

// After
tabs: { serializer: titleFilenameSerializer('title') }
posts: { directory: './blog', serializer: bodyFieldSerializer('content') }
settings: {}
```

### Custom Serializer Migration

```typescript
// Before (flat structure)
recipes: {
  serialize: ({ row }) => ({ frontmatter, body, filename }),
  deserialize: ({ frontmatter, body, filename, table }) => Ok(row),
  extractRowIdFromFilename: (filename) => id,
}

// After (nested structure)
recipes: {
  serializer: {
    serialize: ({ row }) => ({ frontmatter, body, filename }),
    deserialize: {
      parseFilename: (filename) => ({ id }),
      fromContent: ({ frontmatter, body, filename, parsed, table }) => Ok(row),
    },
  },
}
```

### Builder Pattern for Type-Safe Custom Serializers

The new `defineSerializer()` builder provides bidirectional type flow:
- `TFilename`: Inferred from parser input → enforced on serialize return
- `TParsed`: Inferred from parser return → provided to fromContent's parsed param

```typescript
import { defineSerializer } from '@epicenter/hq/providers/markdown';

// Basic usage
const serializer = defineSerializer<MySchema>()
  .withParser((filename: `${string}.md`) => {
    const id = path.basename(filename, '.md');
    return { id };
  })
  .withCodecs({
    serialize: ({ row }) => ({
      frontmatter: { ...row },
      body: '',
      filename: `${row.id}.md`,  // Type-checked: must match parser's TFilename
    }),
    fromContent: ({ parsed, frontmatter }) => {
      // parsed.id is fully typed from parser's return!
      return Ok({ id: parsed.id, ...frontmatter });
    },
  });

// Advanced: Extract extra data from filename
type TitleIdFilename = `${string}-${string}.md`;

const titleSerializer = defineSerializer<TabSchema>()
  .withParser((filename: TitleIdFilename) => {
    const basename = path.basename(filename, '.md');
    const lastDash = basename.lastIndexOf('-');
    return {
      id: basename.substring(lastDash + 1),
      titleFromFilename: basename.substring(0, lastDash),
    };
  })
  .withCodecs({
    serialize: ({ row }) => ({
      frontmatter: {},
      body: '',
      filename: `${row.title}-${row.id}.md` as TitleIdFilename,
    }),
    fromContent: ({ parsed }) => {
      // parsed.titleFromFilename is typed!
      console.log(parsed.titleFromFilename);
      return Ok({ id: parsed.id, ... });
    },
  });
```

### Type Safety Improvements

- Clear separation between WHERE (directory) and HOW (serializer)
- Nested `deserialize` structure reflects the two-step decode process
- `TParsed` type flows from `parseFilename` return to `fromContent` input
- `TFilename` template literal type flows from parser input to serialize return
- Internal `ResolvedTableConfig` type ensures all required fields are present after resolution
- Builder pattern enables full type inference without manual type annotations
