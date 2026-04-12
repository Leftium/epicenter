# Typed createMaterializer with factory pattern and closure-based document access

## Task

Replace the markdown-specific `markdownMaterializer` with a general `createMaterializer` factory that follows the factory function composition pattern. First arg is the resource (`tables`), second is config (`{ directory }`). Returns a builder with `.table()` for per-table overrides. All tables materialize by default. KV materializes to a single JSON file.

The serialize contract is general: `{ filename, content }`. A `markdown()` helper handles the common case of frontmatter + body. This eliminates the two app-specific materializers (fuji, opensidian) and generalizes beyond markdown.

## The Problem

The generic `markdownMaterializer` has three categories of issues:

**Type holes:**
1. Table names are untyped strings — `tables: { entries: {...} }` doesn't validate that `entries` exists
2. Row data is `Record<string, unknown>` — the serialize callback can't access `row.title` without casting
3. Document names are untyped strings — no validation that a document exists

**Markdown-specific contract:**
4. Serialize returns `{ frontmatter, body, filename }` — hardcoded to markdown format
5. No support for JSON, YAML, or custom file formats
6. No KV materialization

**Code duplication:**
7. Two app-specific materializers (~350 lines) exist solely because the generic one can't read documents

## Current Architecture

### Generic markdownMaterializer (`packages/workspace/src/extensions/materializer/markdown/markdown.ts`)

```typescript
// Returns a factory — called BEFORE context is available
export function markdownMaterializer(config: MarkdownMaterializerConfig) {
    return ({ tables }: ExtensionContext) => {
        // tables accessed by untyped string key: tables[tableKey]
        // serializer.serialize(row) — row is Record<string, unknown>
        // returns { frontmatter, body, filename } — markdown-only
    };
}
```

### App-specific materializers that should not exist

1. `apps/fuji/src/lib/materializer.ts` — reads `documents.entries.content.open(row.id)`
2. `playground/opensidian-e2e/materializer.ts` — reads `documents.files.content.open(row.id)`

Both are ~80% identical to the generic materializer. The only differences: which table/document to use and frontmatter field selection.

### How vault config uses both today (`~/Code/vault/epicenter.config.ts`)

```typescript
// Tab manager: generic materializer (no documents)
export const tabManager = createTabManagerWorkspace()
    .withWorkspaceExtension('markdown', markdownMaterializer({
        directory: join(import.meta.dir, 'tab-manager'),
        tables: {
            savedTabs: { serializer: titleFilenameSerializer('title') },
            bookmarks: { serializer: titleFilenameSerializer('title') },
            devices: {},
        },
    }));

// Fuji: app-specific materializer (needs document content)
export const fuji = createFujiWorkspace()
    .withWorkspaceExtension('markdown', createFujiMaterializer({
        directory: import.meta.dir,
    }));
```

## New API Design

### Factory function pattern

Following the factory function composition skill: first arg is the resource (typed `tables`), second arg is config.

```typescript
function createMaterializer<TTables extends Record<string, TableHelper<any>>>(
    tables: TTables,
    config: { directory: string },
): MaterializerBuilder<TTables>;
```

The factory receives the typed `tables` object. This gives it:
- `keyof TTables` for validated table name strings
- `TTables[K]` for row type inference per table
- Table key names for default subdirectory names

### All tables materialize by default

`createMaterializer(tables, { directory })` immediately materializes every table with defaults:
- Serialize: all fields as frontmatter, `{id}.md` filename (markdown format)
- Directory: `{directory}/{tableName}/`

Chain `.table()` only for tables that need customization. Chain `.skip()` to exclude tables.

### General serialize contract

```typescript
type SerializeResult = {
    filename: string;
    content: string;
};

type MaybePromise<T> = T | Promise<T>;
```

The materializer writes `{ filename, content }`. It doesn't know or care about markdown, JSON, or any format.

### `markdown()` helper for the common case

```typescript
/**
 * Convert frontmatter + body to a markdown file result.
 *
 * Applies epicenter link → wikilink conversion to body content.
 * Handles undefined body (frontmatter-only output).
 */
function markdown(input: {
    frontmatter: Record<string, unknown>;
    body?: string;
    filename: string;
}): SerializeResult {
    const processedBody = input.body
        ? convertEpicenterLinksToWikilinks(input.body)
        : input.body;
    return {
        filename: input.filename,
        content: toMarkdown(input.frontmatter, processedBody),
    };
}
```

### `.table()` chain with typed overrides

```typescript
interface MaterializerBuilder<TTables> {
    /**
     * Override materialization config for a specific table.
     *
     * Table name is validated against TTables keys.
     * Serialize callback receives typed row inferred from the table.
     */
    table<K extends keyof TTables & string>(
        name: K,
        config: {
            dir?: string;
            serialize?: TTables[K] extends TableHelper<infer TRow>
                ? (row: TRow) => MaybePromise<SerializeResult>
                : never;
        },
    ): this;

    /** Exclude tables from materialization. */
    skip(...names: (keyof TTables & string)[]): this;

    /** Extension lifecycle. */
    whenReady: Promise<void>;
    dispose(): void;
}
```

### KV materialization

By default, all KV data materializes to a single `{directory}/kv.json` file containing all key-value pairs as a flat JSON object. Override with `.kv()` if needed.

```typescript
interface MaterializerBuilder<TTables> {
    // ... table methods above ...

    /**
     * Override KV materialization.
     * Default: all KV → {directory}/kv.json
     */
    kv(config: {
        /** Custom filename. Default: 'kv.json'. */
        filename?: string;
        /** Disable KV materialization. */
        skip?: boolean;
    }): this;
}
```

## Desired End State

### Vault config after migration

```typescript
import {
    createMaterializer,
    markdown,
    slugFilename,
    toSlugFilename,
} from '@epicenter/workspace/extensions/materializer';

// Tab manager — override filename strategy, everything else defaults
export const tabManager = createTabManagerWorkspace()
    .withWorkspaceExtension('materializer', ({ tables }) =>
        createMaterializer(tables, {
            directory: join(import.meta.dir, 'tab-manager'),
        })
        .table('savedTabs', { serialize: slugFilename('title') })
        .table('bookmarks', { serialize: slugFilename('title') })
        // devices: default (all fields as markdown frontmatter, devices/{id}.md)
    );

// Fuji — custom serialize with document content via closure
export const fuji = createFujiWorkspace()
    .withWorkspaceExtension('materializer', ({ tables, documents }) =>
        createMaterializer(tables, { directory: import.meta.dir })
        .table('entries', {
            dir: 'fuji',
            serialize: async (row) => markdown({
                // row: Entry — inferred from tables['entries']
                frontmatter: {
                    id: row.id,
                    title: row.title,
                    subtitle: row.subtitle,
                    type: row.type,
                    tags: row.tags,
                    createdAt: row.createdAt,
                    updatedAt: row.updatedAt,
                },
                body: await documents.entries.content
                    .open(row.id)
                    .then((h) => h.read())
                    .catch(() => undefined),
                filename: toSlugFilename(row.title, row.id),
            }),
        })
    );
```

### Opensidian e2e config after migration

```typescript
export const opensidian = createWorkspace(opensidianDefinition)
    .withWorkspaceExtension('materializer', ({ tables, documents }) =>
        createMaterializer(tables, {
            directory: join(import.meta.dir, 'data'),
        })
        .table('files', {
            serialize: async (row) => {
                // row: FileRow — inferred from tables['files']
                if (row.type === 'folder') {
                    return markdown({
                        frontmatter: { id: row.id, name: row.name, type: 'folder' },
                        filename: toIdFilename(row.id),
                    });
                }
                return markdown({
                    frontmatter: {
                        id: row.id,
                        name: row.name,
                        parentId: row.parentId,
                        size: row.size,
                        createdAt: row.createdAt,
                        updatedAt: row.updatedAt,
                        trashedAt: row.trashedAt,
                    },
                    body: await documents.files.content
                        .open(row.id)
                        .then((h) => h.read())
                        .catch(() => undefined),
                    filename: toSlugFilename(
                        row.name.replace(/\.md$/i, ''),
                        row.id,
                    ),
                });
            },
        })
    );
```

### Non-markdown example (JSON materialization)

```typescript
// Materialize devices as individual JSON files instead of markdown
createMaterializer(tables, { directory: '...' })
    .table('devices', {
        serialize: (row) => ({
            filename: `${row.id}.json`,
            content: JSON.stringify(row, null, 2),
        }),
    })
```

## Materialization Model

| Source | Target | Default |
|---|---|---|
| Table row | One file per row | Markdown: frontmatter + `{id}.md` |
| KV | One JSON file for all KV | `{directory}/kv.json` |
| Table (all rows) | NOT SUPPORTED | Use custom extension if needed |

**Row → file** is the core use case (browsable content: notes, bookmarks, entries).
**KV → file** is natural (small, flat, key-value shaped).
**Table → file** is an export concern, not a materialization concern. Out of scope.

## Exported API Surface

### Factory

- `createMaterializer(tables, config)` — factory: resource first, config second

### Serialize presets (return `SerializeResult`)

- `slugFilename(field)` — all fields as markdown frontmatter, slugified `{title}-{id}.md`
- `bodyField(field)` — extracts one field as markdown body, rest as frontmatter, `{id}.md`
- Default (when serialize omitted): all fields as markdown frontmatter, `{id}.md`

### Helpers

- `markdown({ frontmatter, body, filename })` — converts to `{ filename, content }` with wikilink processing
- `toSlugFilename(title, id)` — standalone string utility: `{slug}-{id}.md`
- `toIdFilename(id)` — standalone string utility: `{id}.md`
- `toMarkdown(frontmatter, body?)` — pure YAML frontmatter + body assembly (already exists)

### Types

- `SerializeResult` — `{ filename: string; content: string }`
- `MaybePromise<T>` — `T | Promise<T>`

## Files to Modify

### Primary (new materializer)

- `packages/workspace/src/extensions/materializer/` — new `createMaterializer` implementation. Consider whether it replaces `materializer/markdown/` or lives alongside it at `materializer/filesystem/` or `materializer/index.ts`.
- `packages/workspace/src/extensions/materializer/markdown/serializers.ts` — adapt existing serializer factories to return `SerializeResult` (general contract). Rename: `titleFilenameSerializer` → `slugFilename`, `bodyFieldSerializer` → `bodyField`. Add `toSlugFilename`, `toIdFilename` standalone utilities.
- `packages/workspace/src/extensions/materializer/markdown/markdown.ts` — extract `toMarkdown` as a reusable utility. The `markdown()` helper wraps it with wikilink conversion. The old `markdownMaterializer` function is deleted.
- `packages/workspace/src/extensions/materializer/markdown/index.ts` — update exports for new API surface.

### Secondary (consumers to delete)

- `apps/fuji/src/lib/materializer.ts` — **delete**
- `apps/fuji/package.json` — remove `"./materializer"` export, remove `@sindresorhus/slugify` and `filenamify` deps
- `playground/opensidian-e2e/materializer.ts` — **delete**

### Tertiary (consumers to migrate)

- `playground/opensidian-e2e/epicenter.config.ts` — use `createMaterializer` with `.table()` override
- `playground/tab-manager-e2e/epicenter.config.ts` — use `createMaterializer` if applicable
- `packages/cli/test/fixtures/*/epicenter.config.ts` — grep for materializer usage, migrate
- Any file importing from `@epicenter/workspace/extensions/materializer/markdown`

### External (vault — not in monorepo)

- `~/Code/vault/epicenter.config.ts` — replace both materializer setups with `createMaterializer`

## Design Decisions

### 1. General serialize contract: `{ filename, content }`

The materializer writes files. It doesn't care about format. Markdown-specific logic (`toMarkdown`, wikilink conversion) lives in the `markdown()` helper, not in the materializer core. This lets the same materializer handle markdown, JSON, YAML, or any custom format.

### 2. Factory function pattern: resource first, config second

`createMaterializer(tables, { directory })` follows the universal factory function signature. `tables` is the resource (typed, from extension closure). `{ directory }` is the config. Two args max.

### 3. Default-materialize-all with `.table()` overrides

All tables materialize with sensible defaults (markdown frontmatter, `{id}.md`). Chain `.table(name, config)` only for tables that need customization. `.skip(name)` for tables that shouldn't materialize. This minimizes config for simple cases.

### 4. Typed table names via generic + `keyof`

`.table('entries', ...)` validates `'entries'` against `keyof TTables`. Typo → TypeScript error. Row type in serialize callback inferred from `TTables['entries']`. Table key doubles as default subdirectory name.

### 5. Document access through closure, not context parameter

`serialize(row)` receives only the typed row. Document access happens through the extension closure (`documents.entries.content.open(row.id)`). This is fully typed with autocomplete. No `readDocument` helper or `SerializeContext` needed.

### 6. Row → file only, no table → file

Each row materializes as one file. There is no "dump entire table to one file" mode. That's an export concern, not a materialization concern. KV is the exception because it's naturally a flat structure.

### 7. KV → one JSON file

All KV data materializes to `{directory}/kv.json` by default. Simple, obvious, sufficient for the small amount of data KV typically holds.

### 8. `markdown()` helper applies wikilink conversion

The `markdown()` helper calls `convertEpicenterLinksToWikilinks` on body content. This is the only place epicenter-specific link processing happens. Custom serialize callbacks that don't use `markdown()` don't get link conversion — that's intentional.

## Breaking Changes

Clean break. No backward compatibility.

- `markdownMaterializer` → `createMaterializer`
- `MarkdownSerializer` type → deleted
- `MarkdownMaterializerConfig` type → deleted
- `serializer` config property → `.table(name, { serialize })` chain method
- `defaultSerializer()` → omit serialize (default behavior)
- `bodyFieldSerializer(field)` → `bodyField(field)`
- `titleFilenameSerializer(field)` → `slugFilename(field)`
- Serialize return: `{ frontmatter, body, filename }` → `{ filename, content }` (use `markdown()` helper)

All consumers in the monorepo must be migrated in the same commit.

## MUST DO

- Implement `createMaterializer(tables, config)` factory returning builder with `.table()`, `.skip()`, `.kv()`
- Generic type parameter on factory for `TTables` — infer from `tables` arg
- `.table(name, config)` validates name as `keyof TTables`, infers row type for serialize callback
- General serialize contract: `{ filename: string; content: string }`
- `markdown()` helper: `{ frontmatter, body, filename }` → `{ filename, content }` with wikilink conversion
- Default materialization: all tables, markdown frontmatter, `{id}.md`, `{directory}/{tableName}/`
- KV materialization: `{directory}/kv.json` by default
- Rename serialize presets: `slugFilename(field)`, `bodyField(field)`
- Export standalone utilities: `toSlugFilename(title, id)`, `toIdFilename(id)`
- Delete `apps/fuji/src/lib/materializer.ts`
- Delete `playground/opensidian-e2e/materializer.ts`
- Update `apps/fuji/package.json`: remove `"./materializer"` export, remove deps
- Migrate all config files
- Run `bun test packages/workspace` to verify no regressions
- Run `bun x epicenter start . --verbose` from `~/Code/vault` after migration

## MUST NOT DO

- Do not add backward compatibility for old `markdownMaterializer` API
- Do not support table → one file (all rows in single file)
- Do not add new dependencies to `packages/workspace`
- Do not modify `packages/workspace/src/workspace/types.ts`
- Do not remove `toMarkdown` utility — it's still needed by the `markdown()` helper
