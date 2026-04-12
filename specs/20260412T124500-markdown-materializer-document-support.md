# Typed markdownMaterializer with closure-based document access

## Task

Redesign the `markdownMaterializer` API from scratch. Replace untyped string keys and `MarkdownSerializer` objects with typed table helpers and a `serialize` callback that infers row types. Eliminate `SerializeContext`/`readDocument`—document access happens through the extension closure, which is already fully typed.

After this change, the two app-specific materializers (fuji, opensidian) are deleted—their logic collapses into inline `serialize` callbacks on the generic materializer.

## The Problem

The generic `markdownMaterializer` has three type holes:

1. **Table names are untyped strings** — `tables: { entries: {...} }` doesn't validate that `entries` exists
2. **Row data is `Record<string, unknown>`** — the serialize callback can't access `row.title` without casting
3. **Document names are untyped strings** — `readDocument('content')` doesn't validate the document exists

All three are solvable because `.withWorkspaceExtension` gives you a **fully typed** extension context in its closure. The current API throws that away by accepting config before the context is available.

There are currently **two** app-specific materializers that exist solely because the generic one can't read documents:

1. `apps/fuji/src/lib/materializer.ts` — reads `documents.entries.content.open(row.id)` for entry body
2. `playground/opensidian-e2e/materializer.ts` — reads `documents.files.content.open(row.id)` for file body

Both are ~80% identical to the generic materializer. The only differences: which table/document to use, which frontmatter fields to include.

## Current Architecture

### Generic markdownMaterializer (`packages/workspace/src/extensions/materializer/markdown/markdown.ts`)

```typescript
// Returns a factory — called BEFORE context is available
export function markdownMaterializer(config: MarkdownMaterializerConfig) {
    return ({ tables }: ExtensionContext) => {
        // tables accessed by string key: tables[tableKey]
        // serializer.serialize(row) — row is Record<string, unknown>
    };
}
```

Config type:

```typescript
export type MarkdownMaterializerConfig = {
    directory: string;
    tables: Record<string, {         // ← untyped string keys
        directory?: string;
        serializer?: MarkdownSerializer;
    }>;
};
```

Serializer interface (`serializers.ts`):

```typescript
export type MarkdownSerializer = {
    serialize(row: Record<string, unknown>): {  // ← untyped row
        frontmatter: Record<string, unknown>;
        body?: string;
        filename: string;
    };
};
```

### Built-in serializer factories (`serializers.ts`)

Three factories return `MarkdownSerializer` objects:

- `defaultSerializer()` — all fields as frontmatter, `{id}.md` filename
- `bodyFieldSerializer(fieldName)` — extracts one row field as body
- `titleFilenameSerializer(fieldName)` — slugified `{title}-{id}.md` filename

### App-specific materializer pattern (fuji, `apps/fuji/src/lib/materializer.ts`)

```typescript
export function createFujiMaterializer({ directory }: { directory: string }) {
    return ({ tables, documents, whenReady }: MaterializerContext) => {
        async function materializeEntry(row: Entry): Promise<void> {
            const handle = await documents.entries.content.open(row.id);
            content = handle.read();
            const frontmatter = { id: row.id, title: row.title, ... };
            await Bun.write(join(dir, filename), toMarkdown(frontmatter, content));
        }
        // observe table, materialize on change — identical to generic
    };
}
```

### Opensidian app-specific materializer (`playground/opensidian-e2e/materializer.ts`)

Same pattern, different table/document names:

```typescript
export function createOpensidianMaterializer({ directory }: { directory: string }) {
    return ({ tables, documents, whenReady }: MaterializerContext) => {
        async function materializeFile(row: FileRow): Promise<void> {
            if (row.type === 'folder') return;
            const handle = await documents.files.content.open(row.id);
            content = handle.read();
            const exportedContent = convertEpicenterLinksToWikilinks(content);
            // ... same observe/write pattern
        }
    };
}
```

### How vault config uses both today (`~/Code/vault/epicenter.config.ts`)

```typescript
// Tab manager: uses GENERIC materializer (no documents)
export const tabManager = createTabManagerWorkspace()
    .withWorkspaceExtension('markdown', markdownMaterializer({
        directory: join(import.meta.dir, 'tab-manager'),
        tables: {
            savedTabs: { serializer: titleFilenameSerializer('title') },
            bookmarks: { serializer: titleFilenameSerializer('title') },
            devices: {},
        },
    }));

// Fuji: uses APP-SPECIFIC materializer (needs document content)
export const fuji = createFujiWorkspace()
    .withWorkspaceExtension('markdown', createFujiMaterializer({
        directory: import.meta.dir,
    }));
```

## New API Design

### Key insight

`markdownMaterializer` is no longer a factory-returning-factory. It's called **inside** the `.withWorkspaceExtension` closure, receives typed table helpers directly, and returns the extension result.

```
Before: markdownMaterializer(config) → (context) → extensionResult
After:  (context) → markdownMaterializer(config) → extensionResult
```

The caller passes typed table helpers from the closure. The materializer infers row types from them.

### Core types

```typescript
/** Result of serializing a row to markdown. */
type SerializeResult = {
    frontmatter: Record<string, unknown>;
    body?: string;
    filename: string;
};

type MaybePromise<T> = T | Promise<T>;

/**
 * Serialize a typed row to markdown output.
 *
 * Receives the full typed row — no Record<string, unknown>.
 * Document access happens through the extension closure, not
 * through a context parameter.
 */
type SerializeFn<TRow> = (row: TRow) => MaybePromise<SerializeResult>;
```

No `SerializeContext`. No `readDocument`. The callback just receives the typed row. If you need documents, you close over `documents` from the extension context—which is fully typed with autocomplete.

### `materializeTable` helper

This is the type inference bridge. It accepts a typed table helper and returns a config object with the row type erased (the materializer only needs untyped internals).

```typescript
/** Structural type for the table helper methods the materializer needs. */
type MaterializableTable<TRow> = {
    getAllValid(): TRow[];
    get(id: string):
        | { status: 'valid'; row: TRow }
        | { status: 'not_found' }
        | { status: 'invalid' };
    observe(callback: (changedIds: ReadonlySet<string>) => void): () => void;
};

/** Type-erased config the materializer iterates over internally. */
type MaterializeEntry = {
    table: MaterializableTable<Record<string, unknown>>;
    directory?: string;
    serialize: SerializeFn<Record<string, unknown>>;
};

/**
 * Create a type-safe materialization config for a single table.
 *
 * TypeScript infers TRow from the table helper, then flows it into
 * the serialize callback. The return type erases TRow—the materializer
 * internally only needs untyped table operations.
 *
 * @example
 * ```typescript
 * materializeTable(tables.entries, {
 *     directory: 'fuji',
 *     serialize: async (row) => ({
 *         // row: Entry — inferred from tables.entries!
 *         frontmatter: { id: row.id, title: row.title },
 *         body: await documents.entries.content.open(row.id).then(h => h.read()),
 *         filename: titleFilename(row.title, row.id),
 *     }),
 * })
 * ```
 */
function materializeTable<TRow extends { id: string }>(
    table: MaterializableTable<TRow>,
    config?: {
        directory?: string;
        serialize?: SerializeFn<TRow>;
    },
): MaterializeEntry {
    return {
        table: table as MaterializableTable<Record<string, unknown>>,
        directory: config?.directory,
        serialize: (config?.serialize ?? defaultSerialize()) as SerializeFn<Record<string, unknown>>,
    };
}
```

### Updated `markdownMaterializer`

No longer a factory-returning-factory. Called inside the closure, returns the extension result directly.

```typescript
type MarkdownMaterializerConfig = {
    directory: string;
    tables: MaterializeEntry[];
};

/**
 * One-way markdown materializer. Observes tables and writes .md files.
 *
 * Called inside a .withWorkspaceExtension closure — NOT as a standalone
 * factory. This gives callers typed access to tables and documents.
 *
 * @returns Extension result with whenReady and dispose.
 */
function markdownMaterializer(config: MarkdownMaterializerConfig): {
    whenReady: Promise<void>;
    dispose(): void;
} {
    const unsubscribers: Array<() => void> = [];

    const whenReady = (async () => {
        for (const entry of config.tables) {
            const dir = join(config.directory, entry.directory ?? '???');
            // ... mkdir, initial materialization, observe
            // Each row: const result = await entry.serialize(row);
        }
    })();

    return {
        whenReady,
        dispose() { for (const unsub of unsubscribers) unsub(); },
    };
}
```

Note: the materializer needs a way to determine the default subdirectory name. Currently it uses the string table key from the config record. With an array of `MaterializeEntry`, there's no implicit name. Options:
- Require `directory` on every entry (explicit, no magic)
- Add a `name` field to `MaterializeEntry` for the subdirectory default
- Use the table helper's internal name if it exposes one

**Recommended**: require `directory` on every entry. It's one extra string per table and eliminates ambiguity. Check if table helpers expose a name property — if so, use it as the default.

### Built-in serialize helpers

Same as before, but typed as `SerializeFn<Record<string, unknown>>` (compatible with any row type via contravariance):

```typescript
/** All fields as frontmatter, {id}.md filename. */
export function defaultSerialize(): SerializeFn<Record<string, unknown>> {
    return (row) => ({
        frontmatter: { ...row },
        filename: `${row.id}.md`,
    });
}

/** Extract one row field as body, remaining fields as frontmatter. */
export function bodyFieldSerialize(fieldName: string): SerializeFn<Record<string, unknown>> {
    return (row) => {
        const { [fieldName]: bodyValue, ...rest } = row;
        return {
            frontmatter: rest,
            body: bodyValue != null ? String(bodyValue) : undefined,
            filename: `${row.id}.md`,
        };
    };
}

/** Slugified {title}-{id}.md filename, all fields as frontmatter. */
export function titleFilenameSerialize(fieldName: string): SerializeFn<Record<string, unknown>> {
    return (row) => ({
        frontmatter: { ...row },
        filename: titleFilename(String(row[fieldName] ?? ''), String(row.id)),
    });
}
```

### Standalone filename utilities

```typescript
/** Slugified `{title}-{id}.md`, falling back to `{id}.md`. */
export function titleFilename(title: string, id: string): string {
    const slug = slugify(title.trim()).slice(0, MAX_SLUG_LENGTH);
    return slug
        ? filenamify(`${slug}-${id}.md`, { replacement: '-' })
        : `${id}.md`;
}

/** Simple `{id}.md` filename. */
export function idFilename(id: string): string {
    return `${id}.md`;
}
```

## Desired End State

### Vault config after migration

```typescript
import {
    markdownMaterializer,
    materializeTable,
    titleFilename,
    titleFilenameSerialize,
} from '@epicenter/workspace/extensions/materializer/markdown';

// Tab manager — typed table helpers, inferred row types
export const tabManager = createTabManagerWorkspace()
    .withWorkspaceExtension('markdown', ({ tables }) =>
        markdownMaterializer({
            directory: join(import.meta.dir, 'tab-manager'),
            tables: [
                materializeTable(tables.savedTabs, {
                    directory: 'savedTabs',
                    serialize: titleFilenameSerialize('title'),
                }),
                materializeTable(tables.bookmarks, {
                    directory: 'bookmarks',
                    serialize: titleFilenameSerialize('title'),
                }),
                materializeTable(tables.devices, {
                    directory: 'devices',
                }),
            ],
        })
    );

// Fuji — typed rows, document access through closure
export const fuji = createFujiWorkspace()
    .withWorkspaceExtension('markdown', ({ tables, documents }) =>
        markdownMaterializer({
            directory: import.meta.dir,
            tables: [
                materializeTable(tables.entries, {
                    directory: 'fuji',
                    serialize: async (row) => ({
                        // row: Entry — inferred from tables.entries
                        // row.id, row.title, row.tags — all autocomplete
                        frontmatter: {
                            id: row.id,
                            title: row.title,
                            subtitle: row.subtitle,
                            type: row.type,
                            tags: row.tags,
                            createdAt: row.createdAt,
                            updatedAt: row.updatedAt,
                        },
                        // documents.entries.content — fully typed, autocompletes
                        body: await documents.entries.content
                            .open(row.id)
                            .then((h) => h.read())
                            .catch(() => undefined),
                        filename: titleFilename(row.title, row.id),
                    }),
                }),
            ],
        })
    );
```

### Opensidian e2e config after migration

```typescript
export const opensidian = createWorkspace(opensidianDefinition)
    .withWorkspaceExtension('markdown', ({ tables, documents }) =>
        markdownMaterializer({
            directory: join(import.meta.dir, 'data'),
            tables: [
                materializeTable(tables.files, {
                    directory: 'files',
                    serialize: async (row) => {
                        // row: FileRow — inferred from tables.files
                        if (row.type === 'folder') {
                            return {
                                frontmatter: { id: row.id, name: row.name, type: 'folder' },
                                filename: idFilename(row.id),
                            };
                        }
                        return {
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
                            filename: titleFilename(
                                row.name.replace(/\.md$/i, ''),
                                row.id,
                            ),
                        };
                    },
                }),
            ],
        })
    );
```

## What's eliminated vs the old API

| Old API | New API | Why it's better |
|---|---|---|
| `MarkdownSerializer` type (object with method) | `SerializeFn<TRow>` (plain function) | Simpler, generic over row type |
| `serializer` property | `serialize` property on `materializeTable` | Same concept, better name |
| `tables: Record<string, {...}>` (string keys) | `tables: [materializeTable(tables.foo, {...})]` | Typed table refs, no string key typos |
| `row: Record<string, unknown>` in serialize | `row: TRow` inferred from table helper | Full autocomplete on row fields |
| `readDocument('content')` with `SerializeContext` | `documents.entries.content.open(row.id)` via closure | Fully typed, autocompletes document names |
| `markdownMaterializer(config)` returns factory | `markdownMaterializer(config)` returns extension result | Called inside typed closure |
| App-specific materializers (fuji, opensidian) | Inline `serialize` callbacks | ~350 lines of duplicated code deleted |

## Files to Modify

### Primary (the generic materializer)

- `packages/workspace/src/extensions/materializer/markdown/markdown.ts` — rewrite `markdownMaterializer` to accept `MaterializeEntry[]` (from `materializeTable`); no longer a factory-returning-factory; destructure nothing from context (caller passes table helpers); support async serialize; add `materializeTable` generic helper function
- `packages/workspace/src/extensions/materializer/markdown/serializers.ts` — delete `MarkdownSerializer` type; rename factories to `*Serialize` returning `SerializeFn`; add `SerializeFn` and `SerializeResult` types; export `titleFilename` and `idFilename` standalone utilities
- `packages/workspace/src/extensions/materializer/markdown/index.ts` — update exports: add `materializeTable`, `SerializeFn`, `SerializeResult`, `MaterializeEntry`, `titleFilename`, `idFilename`; remove `MarkdownSerializer`; rename serializer exports

### Secondary (consumers to delete)

- `apps/fuji/src/lib/materializer.ts` — **delete**
- `apps/fuji/package.json` — remove `"./materializer"` export, remove `@sindresorhus/slugify` and `filenamify` deps
- `playground/opensidian-e2e/materializer.ts` — **delete**

### Tertiary (consumers to migrate)

- `playground/opensidian-e2e/epicenter.config.ts` — wrap `markdownMaterializer` in `.withWorkspaceExtension` closure; use `materializeTable` with inline serialize
- `playground/tab-manager-e2e/epicenter.config.ts` — same pattern; check if it uses the materializer
- `packages/cli/test/fixtures/*/epicenter.config.ts` — grep for materializer usage, migrate if found
- Any other file importing `MarkdownSerializer`, `defaultSerializer`, `bodyFieldSerializer`, `titleFilenameSerializer`

### External (vault — not in monorepo)

- `~/Code/vault/epicenter.config.ts` — replace `createFujiMaterializer` import with generic materializer + inline serialize; wrap both workspaces' materializer config in closure

## Design Decisions (Already Made)

### 1. `markdownMaterializer` is NOT a factory-returning-factory

Old: `markdownMaterializer(config)` returns `(context) => result`. Config is created before context exists — no access to typed tables/documents.

New: `markdownMaterializer(config)` returns the extension result directly. Called inside the `.withWorkspaceExtension` closure where context is available. The caller passes typed table helpers via `materializeTable`.

This breaks the `configFn(config) → factory` pattern used by other extensions (`filesystemPersistence`, `createSyncExtension`). The break is justified: the materializer is the only extension that benefits from typed table/document access in its config.

### 2. `materializeTable` is the type inference bridge

TypeScript can't infer generic types from object literal properties in an array. `materializeTable(table, config)` is a function call that triggers generic inference: `TRow` is inferred from `table`, then flows into `serialize(row: TRow)`.

Without this helper, `row` would be `Record<string, unknown>` and you'd lose autocomplete.

### 3. No `SerializeContext` or `readDocument`

Document access through closure is **strictly better**:
- Fully typed (autocomplete on document names)
- No intermediate abstraction
- No `(documents as any)` casts inside the materializer
- Callers already have `documents` in scope

### 4. `serialize` receives only `row` — no context parameter

The serialize callback is `(row: TRow) => MaybePromise<SerializeResult>`. One input, one output. Everything else (documents, other tables, utilities) comes from the closure. Clean, testable, composable.

### 5. Wikilink conversion applies to all body content

The generic materializer calls `convertEpicenterLinksToWikilinks` on body content from serialize. This covers both row-based body and document-based body. No special handling needed.

### 6. `directory` should be explicit on every `materializeTable` call

With string-keyed tables, the key doubled as the subdirectory name. With array-based tables, there's no implicit name. Making `directory` explicit is one extra string per table and eliminates magic. Check if the table helper exposes an internal name property — if so, it could serve as a default fallback.

## MUST DO

- Rewrite `markdownMaterializer` to accept `{ directory, tables: MaterializeEntry[] }` and return extension result directly (not a factory)
- Implement `materializeTable<TRow>` generic helper for type inference
- Replace `MarkdownSerializer` type with `SerializeFn<TRow>` type
- Rename built-in factories: `defaultSerializer` → `defaultSerialize`, `bodyFieldSerializer` → `bodyFieldSerialize`, `titleFilenameSerializer` → `titleFilenameSerialize`
- Export standalone `titleFilename(title, id)` and `idFilename(id)` utilities
- Export `materializeTable`, `SerializeFn`, `SerializeResult`, `MaterializeEntry` from the index
- Support async `serialize` callbacks (the materialization loop must await results)
- Apply `convertEpicenterLinksToWikilinks` to body content from serialize
- Delete `apps/fuji/src/lib/materializer.ts`
- Delete `playground/opensidian-e2e/materializer.ts`
- Update `apps/fuji/package.json`: remove `"./materializer"` export, remove `@sindresorhus/slugify` and `filenamify` deps
- Migrate ALL config files that use the old `serializer` property or `MarkdownSerializer` type
- Run `bun test packages/workspace` to verify no regressions
- Run `bun x epicenter start . --verbose` from `~/Code/vault` after updating vault config

## MUST NOT DO

- Do not add backward compatibility for the old `serializer`/`MarkdownSerializer` API — clean break
- Do not add a `SerializeContext` or `readDocument` helper — document access through closure is the design
- Do not add new dependencies to `packages/workspace`
- Do not change the markdown output format (YAML frontmatter + body)
- Do not modify `packages/workspace/src/workspace/types.ts`
- Do not change how `convertEpicenterLinksToWikilinks` is applied
