# Client Builder API v2: Schema-First Refactor

**Status**: REVERSED (2026-01-22)  
**Created**: 2026-01-21  
**Updated**: 2026-01-22  
**Purpose**: Simplify the client builder API by separating schema from identity  
**Related**:

- [specs/20260121T231500-doc-architecture-v2.md](./20260121T231500-doc-architecture-v2.md)
- [specs/20260121T222800-registry-and-sync-ux.md](./20260121T222800-registry-and-sync-ux.md)

---

## REVERSAL NOTE (2026-01-22)

This spec was implemented but then **reversed**. The rename from `.withDefinition()` to `.withSchema()` was undone because:

1. **Naming inconsistency**: The method accepts `TableDefinitionMap` which contains full `TableDefinition` objects (with metadata like name, icon, description), not just raw type schemas
2. **Convention mismatch**: Per the codebase naming convention in `packages/epicenter/src/core/schema/README.md`:
   - **Schema** = raw type constraints (no metadata)
   - **Definition** = metadata + schema
3. **Y.Map alignment**: The Y.Map was renamed from `Y.Map('schema')` to `Y.Map('definition')` for the same reason—it stores definitions, not schemas

The method is now back to `.withDefinition()`. The `WorkspaceSchema` type still exists as an alias (`WorkspaceDefinitionInput`) for backwards compatibility.

---

## Executive Summary (ORIGINAL - NOW REVERSED)

The current `createClient().withDefinition().withExtensions()` API has redundancy after the doc-architecture-v2 changes. This spec proposed renaming `.withDefinition()` to `.withSchema()` and simplifying the types to reflect the new separation of concerns.

### Key Changes

| Before                                           | After                                                        |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `.withDefinition(definition)`                    | `.withSchema({ tables, kv })`                                |
| `WorkspaceDefinition` includes `id`, `name`      | `WorkspaceSchema` contains only `tables`, `kv`               |
| `defineWorkspace()` returns definition with name | `defineWorkspace()` returns schema (name derived separately) |
| Identity passed redundantly                      | Identity comes from Head Doc                                 |

---

## Problem Statement

After doc-architecture-v2, workspace identity (name, icon, description) moved to the Head Doc:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      CURRENT STATE (Redundant)                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   createClient('my-workspace', { epoch: 0 })                                │
│         │                                                                    │
│         │  workspaceId already passed here ──────────────┐                  │
│         ▼                                                 │                  │
│   .withDefinition({                                       │                  │
│       id: 'my-workspace',  ◄──── REDUNDANT ──────────────┘                  │
│       name: 'My Workspace', ◄──── NOW IN HEAD DOC                           │
│       tables: {...},        ◄──── Actually needed                           │
│       kv: {...}             ◄──── Actually needed                           │
│   })                                                                         │
│         │                                                                    │
│         ▼                                                                    │
│   .withExtensions({...})                                                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

The `.withDefinition()` method:

1. **Ignores** the `id` field (uses the one from `createClient()`)
2. **Uses `name` only as fallback** (real name comes from Head Doc)
3. **Actually uses** only `tables` and `kv` for type-safe operations

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      PROPOSED STATE (Clean Separation)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  HEAD DOC (Identity)                                                 │   │
│   │  ─────────────────────                                               │   │
│   │  Y.Map('meta')                                                       │   │
│   │    ├── name: "My Workspace"                                          │   │
│   │    ├── icon: { type: 'emoji', value: '📝' }                         │   │
│   │    └── description: "A workspace for notes"                          │   │
│   │                                                                      │   │
│   │  Y.Map('epochs')                                                     │   │
│   │    └── [clientId]: number                                            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   createClient('my-workspace', { epoch })                                   │
│         │                                                                    │
│         ▼                                                                    │
│   .withSchema({                                                             │
│       tables: {...},   ◄──── Type definitions for tables                    │
│       kv: {...}        ◄──── Type definitions for KV store                  │
│   })                                                                         │
│         │                                                                    │
│         ▼                                                                    │
│   .withExtensions({...})                                                    │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  WORKSPACE DOC (Data)                                                │   │
│   │  ─────────────────────                                               │   │
│   │  Y.Map('schema')   ◄──── Merged from .withSchema()                  │   │
│   │  Y.Map('tables')   ◄──── Actual row data                            │   │
│   │  Y.Map('kv')       ◄──── Actual KV values                           │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         COMPLETE DATA FLOW                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   DEFINITION TIME                     RUNTIME                                │
│   ───────────────                     ───────                                │
│                                                                              │
│   defineWorkspace({                   const head = createHead(workspaceId)  │
│     id: 'blog',                       await head.whenSynced                  │
│     tables: {...},      ────┐                                                │
│     kv: {...}               │         // Identity from Head Doc              │
│   })                        │         const meta = head.getMeta()            │
│         │                   │         // meta.name, meta.icon, meta.description
│         ▼                   │                                                │
│   WorkspaceSchema           │         const epoch = head.getEpoch()          │
│   {                         │                    │                           │
│     id: 'blog',             │                    ▼                           │
│     tables: {...},  ────────┼──►  createClient(workspaceId, { epoch })       │
│     kv: {...}               │              │                                 │
│   }                         │              ▼                                 │
│                             └────►  .withSchema({ tables, kv })              │
│                                            │                                 │
│                                            ▼                                 │
│                                     .withExtensions({...})                   │
│                                            │                                 │
│                                            ▼                                 │
│                                     WorkspaceClient                          │
│                                     {                                        │
│                                       id: 'blog',                            │
│                                       tables: {...},                         │
│                                       kv: {...},                             │
│                                       extensions: {...}                      │
│                                     }                                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Type Changes

### Before (Current)

```typescript
// WorkspaceDefinition includes identity
type WorkspaceDefinition<TTables, TKv> = {
	id: string; // ← Redundant with createClient() arg
	name: string; // ← Now lives in Head Doc
	tables: TTables;
	kv: TKv;
};

// defineWorkspace returns full definition
function defineWorkspace(input): WorkspaceDefinition;

// Builder accepts full definition
interface ClientBuilder {
	withDefinition(definition: WorkspaceDefinition): ClientBuilder;
	withExtensions(extensions): WorkspaceClient;
}
```

### After (Proposed)

```typescript
// WorkspaceSchema contains only type information
type WorkspaceSchema<TTables, TKv> = {
	tables: TTables;
	kv: TKv;
};

// defineWorkspace returns schema with id for convenience
type WorkspaceDefinition<TTables, TKv> = {
	id: string; // For convenience: createClient(def.id)
	tables: TTables;
	kv: TKv;
};

// Builder accepts just schema
interface ClientBuilder {
	withSchema(schema: WorkspaceSchema | WorkspaceDefinition): ClientBuilder;
	withExtensions(extensions): WorkspaceClient;
}
```

---

## API Comparison

### Current API

```typescript
// Define workspace (includes name)
const definition = defineWorkspace({
	id: 'epicenter.blog',
	tables: {
		posts: table({
			name: 'Posts',
			fields: { id: id(), title: text() },
		}),
	},
	kv: {},
});

// Create client (passes id twice, name ignored)
const client = createClient(definition.id, { epoch })
	.withDefinition(definition)
	.withExtensions({ sqlite, persistence });

// Name comes from... somewhere (fallback logic)
console.log(client.name); // Confusing: where does this come from?
```

### Proposed API

```typescript
// Define workspace (schema only, id for convenience)
const schema = defineWorkspace({
	id: 'epicenter.blog',
	tables: {
		posts: table({
			name: 'Posts',
			fields: { id: id(), title: text() },
		}),
	},
	kv: {},
});

// Create client (clear separation)
const client = createClient(schema.id, { epoch })
	.withSchema(schema) // or .withSchema({ tables: schema.tables, kv: schema.kv })
	.withExtensions({ sqlite, persistence });

// Identity comes from Head Doc (explicit)
const head = createHead(schema.id);
const meta = head.getMeta();
console.log(meta.name); // Clear: identity is from Head Doc
```

---

## Migration Path

### Phase 1: Add `.withSchema()` as Alias

```typescript
// Both work, withDefinition deprecated
.withDefinition(def)  // ← Deprecated, shows warning
.withSchema(schema)   // ← New preferred API
```

### Phase 2: Update Documentation and Examples

All docs, READMEs, and examples updated to use `.withSchema()`.

### Phase 3: Remove `.withDefinition()`

After deprecation period, remove the old method.

---

## Workspace Identity Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    WHERE DOES IDENTITY COME FROM?                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   STATIC WORKSPACE (App-defined, like Whispering)                           │
│   ─────────────────────────────────────────────────                          │
│                                                                              │
│   1. Schema defined in code:                                                 │
│      const whisperingSchema = defineWorkspace({                             │
│        id: 'epicenter.whispering',                                          │
│        tables: { recordings: {...} },                                       │
│        kv: {}                                                                │
│      });                                                                     │
│                                                                              │
│   2. Identity set on first run (in app initialization):                     │
│      const head = createHead('epicenter.whispering');                       │
│      if (!head.hasMeta()) {                                                 │
│        head.setMeta({                                                       │
│          name: 'Whispering',                                                │
│          icon: { type: 'emoji', value: '🎙️' },                             │
│          description: 'Voice recordings and transcriptions'                │
│        });                                                                   │
│      }                                                                       │
│                                                                              │
│   3. Create client with schema:                                             │
│      const client = createClient('epicenter.whispering', { epoch })         │
│        .withSchema(whisperingSchema)                                        │
│        .withExtensions({...});                                              │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   DYNAMIC WORKSPACE (User-created at runtime)                               │
│   ─────────────────────────────────────────────                              │
│                                                                              │
│   1. User creates workspace in UI:                                          │
│      const workspaceId = generateWorkspaceId();                             │
│      registry.addWorkspace(workspaceId);                                    │
│                                                                              │
│   2. User provides identity in creation form:                               │
│      const head = createHead(workspaceId);                                  │
│      head.setMeta({                                                         │
│        name: userInput.name,                                                │
│        icon: userInput.icon,                                                │
│        description: userInput.description                                   │
│      });                                                                     │
│                                                                              │
│   3. Schema comes from template or user-defined:                            │
│      const schema = { tables: {...}, kv: {...} };                           │
│      const client = createClient(workspaceId, { epoch: 0 })                 │
│        .withSchema(schema)                                                  │
│        .withExtensions({...});                                              │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## File Persistence Mapping

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    WHERE DOES EACH PIECE LIVE ON DISK?                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   {appLocalDataDir}/                                                        │
│   └── workspaces/                                                           │
│       └── {workspace-id}/                                                   │
│           │                                                                  │
│           │   IDENTITY (Head Doc)                                           │
│           ├── head.yjs           ◄── Y.Doc: epochs + meta                   │
│           ├── head.json          ◄── Debug mirror:                          │
│           │                          {                                       │
│           │                            "epochs": { "12345": 0 },            │
│           │                            "meta": {                             │
│           │                              "name": "My Workspace",            │
│           │                              "icon": {...},                      │
│           │                              "description": "..."               │
│           │                            }                                     │
│           │                          }                                       │
│           │                                                                  │
│           │   DATA (Workspace Doc per epoch)                                │
│           └── {epoch}/                                                       │
│               ├── workspace.yjs  ◄── Y.Doc: schema + kv + tables            │
│               ├── schema.json    ◄── Extracted from Y.Map('schema'):        │
│               │                      {                                       │
│               │                        "tables": {                          │
│               │                          "posts": {                         │
│               │                            "name": "Posts",                 │
│               │                            "icon": {...},                   │
│               │                            "description": "...",            │
│               │                            "fields": {...}                  │
│               │                          }                                   │
│               │                        },                                    │
│               │                        "kv": {...}                          │
│               │                      }                                       │
│               └── kv.json        ◄── Extracted from Y.Map('kv')             │
│                                                                              │
│   NOTE: workspace-id is the FOLDER NAME, not stored in any JSON file.       │
│   To make files self-describing, we could add "id" to head.json.            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## What Information Is Needed Where?

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    INFORMATION REQUIREMENTS BY OPERATION                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   OPERATION                      NEEDS                    SOURCE             │
│   ─────────────────────────────────────────────────────────────────────────  │
│                                                                              │
│   List workspaces                workspace IDs           Registry Doc        │
│                                                                              │
│   Show workspace in UI           name, icon, description Head Doc (meta)    │
│                                                                              │
│   Determine which epoch          epoch number            Head Doc (epochs)  │
│                                                                              │
│   Create type-safe client        tables, kv schemas      Code or schema.json│
│                                                                              │
│   Read/write table data          (none beyond client)    Workspace Doc      │
│                                                                              │
│   SQL queries                    (client + extension)    SQLite extension   │
│                                                                              │
│   Rename workspace               (just the new name)     Head Doc (setMeta) │
│                                                                              │
│   Bump epoch (migration)         (none)                  Head Doc (bumpEpoch)
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Client Properties After Refactor

```typescript
// WorkspaceClient after refactor
type WorkspaceClient<TTables, TKv, TExtensions> = {
	// Identity (from Y.Doc GUID)
	readonly id: string;

	// REMOVED: name no longer on client
	// Use head.getMeta().name instead

	// Schema-driven operations
	tables: Tables<TTables>;
	kv: Kv<TKv>;

	// Extension exports
	extensions: TExtensions;

	// Y.Doc access
	ydoc: Y.Doc;
	getSchema(): WorkspaceSchemaMap;

	// Lifecycle
	whenSynced: Promise<void>;
	destroy(): Promise<void>;
};
```

**Key change**: `client.name` is removed. Identity comes from Head Doc:

```typescript
// Before (confusing)
console.log(client.name); // Where does this come from?

// After (explicit)
const head = createHead(client.id);
console.log(head.getMeta().name); // Clearly from Head Doc
```

---

## Open Questions

### Q1: Should `defineWorkspace()` still include `id`?

**Proposed**: Yes, for convenience. The `id` is used to call `createClient(def.id)`.

```typescript
const def = defineWorkspace({
  id: 'epicenter.blog',  // ← Kept for createClient(def.id)
  tables: {...},
  kv: {}
});

const client = createClient(def.id, { epoch })
  .withSchema(def)  // ← Accepts { id?, tables, kv }
  .withExtensions({});
```

### Q2: Should we add `id` to `head.json` for self-describing files?

**Proposed**: Yes, improves debuggability.

```json
{
	"id": "epicenter.blog",
	"epochs": { "12345": 0 },
	"meta": {
		"name": "My Blog",
		"icon": { "type": "emoji", "value": "📝" },
		"description": "Personal blog workspace"
	}
}
```

### Q3: Should `client.name` be kept as a convenience getter?

**Proposed**: Remove it. The confusion about "where does name come from" outweighs the convenience. Making identity explicitly come from Head Doc is clearer.

---

## Current Codebase Usage Analysis

### `.withDefinition()` Usages (from codebase exploration)

| Location                                                 | Pattern                | Notes                |
| -------------------------------------------------------- | ---------------------- | -------------------- |
| `apps/epicenter/src/lib/docs/workspace.ts:65`            | Variable passing       | Tauri app wrapper    |
| `packages/epicenter/scripts/email-*.ts`                  | Variable passing       | Simulation scripts   |
| `packages/epicenter/scripts/yjs-vs-sqlite-comparison.ts` | Variable passing       | Performance tests    |
| `packages/epicenter/src/core/workspace/node.ts:371`      | Internal wrapper       | Node.js async helper |
| Multiple READMEs and docs                                | Documentation examples | ~80 grep matches     |

**Key finding**: All real usages pass a **variable** named `definition` or similar. No complex inline objects. This supports the refactor since usage patterns are consistent.

### `defineWorkspace()` Usages

| Location                                                            | Format                | Description                             |
| ------------------------------------------------------------------- | --------------------- | --------------------------------------- |
| `examples/content-hub/.epicenter/workspaces/posts.workspace.ts`     | Uses `table()` helper | 13 social media platform tables         |
| `examples/content-hub/.epicenter/workspaces/clippings.workspace.ts` | Uses `table()` helper | 9 tables with custom markdown providers |
| `examples/content-hub/.epicenter/workspaces/wiki.workspace.ts`      | Uses `table()` helper | Single table with multi-provider sync   |
| `packages/epicenter/scripts/email-*.ts`                             | Uses `table()` helper | Performance simulation scripts          |
| `packages/epicenter/src/core/workspace/workspace.test.ts`           | Both formats          | Test coverage                           |

**Key finding**: Most real usages use the `table()` helper which requires `name` and `fields`. The workspace-level `name` (auto-generated from `id`) is rarely used directly since identity now lives in Head Doc.

### HeadDoc Usage Patterns

| Method            | Usage                                         | Location                                       |
| ----------------- | --------------------------------------------- | ---------------------------------------------- |
| `createHead()`    | App-level factory with `.client()` fluent API | `apps/epicenter/src/lib/docs/head.ts`          |
| `createHeadDoc()` | Core factory for epoch + meta                 | `packages/epicenter/src/core/docs/head-doc.ts` |
| `getMeta()`       | Display workspace name in UI                  | Layout routes in Tauri app                     |
| `setMeta()`       | Workspace creation/renaming                   | Query layer for CRUD                           |
| `hasMeta()`       | Migration detection                           | First-time setup checks                        |

**Key finding**: The app already uses `head.getMeta()` for identity. The `client.name` property is a vestigial convenience that adds confusion.

---

## Implementation Plan

### Phase 1: Core Type Changes

- [ ] **1.1** Add `WorkspaceSchema` type to `packages/epicenter/src/core/workspace/workspace.ts`

  ```typescript
  type WorkspaceSchema<TTables, TKv> = {
  	tables: TTables;
  	kv: TKv;
  };
  ```

- [ ] **1.2** Add `.withSchema()` method to `ClientBuilder` interface
  - Accept both `WorkspaceSchema` and `WorkspaceDefinition` (for backward compat)
  - Internally call the same `createClientBuilder()` logic

- [ ] **1.3** Mark `.withDefinition()` as `@deprecated` with JSDoc
  ```typescript
  /**
   * @deprecated Use `.withSchema()` instead. Identity now comes from Head Doc.
   */
  withDefinition(definition: WorkspaceDefinition): ClientBuilder;
  ```

### Phase 2: Remove Identity from Client

- [ ] **2.1** Remove `name` property from `WorkspaceClient` type
- [ ] **2.2** Remove `fallbackName` from `createClientBuilder()` config
- [ ] **2.3** Remove `fallbackName` from `createClientCore()` implementation
- [ ] **2.4** Update any code that reads `client.name` to use Head Doc

### Phase 3: Persistence Updates

- [ ] **3.1** Add `id` field to `head.json` output in `tauriPersistence`

  ```json
  {
    "id": "epicenter.blog",
    "epochs": {...},
    "meta": {...}
  }
  ```

- [ ] **3.2** Verify `schema.json` doesn't include workspace identity (already correct)

### Phase 4: Documentation

- [ ] **4.1** Update `packages/epicenter/README.md` examples
- [ ] **4.2** Update `packages/epicenter/src/core/workspace/README.md`
- [ ] **4.3** Update `packages/epicenter/src/core/docs/README.md`
- [ ] **4.4** Update `apps/epicenter/src/lib/docs/README.md`
- [ ] **4.5** Update JSDoc in all affected functions

### Phase 5: Migration of Usages

- [ ] **5.1** Update `apps/epicenter/src/lib/docs/workspace.ts`
- [ ] **5.2** Update simulation scripts in `packages/epicenter/scripts/`
- [ ] **5.3** Update any test files

### Phase 6: Cleanup (Future)

- [ ] **6.1** Remove `.withDefinition()` after deprecation period
- [ ] **6.2** Remove `name` from `WorkspaceDefinition` type (keep only in input)

---

## Files to Modify

```
packages/epicenter/
├── src/core/workspace/
│   ├── workspace.ts          # Main changes: types, builder
│   ├── node.ts               # Update async wrapper
│   └── README.md             # Documentation
├── src/core/docs/
│   └── README.md             # Update architecture docs
├── src/index.ts              # Export new types
├── README.md                 # Update examples
└── scripts/
    ├── email-*.ts            # Update usages
    └── yjs-vs-sqlite-*.ts    # Update usages

apps/epicenter/
└── src/lib/docs/
    ├── workspace.ts          # Update to .withSchema()
    └── README.md             # Update docs
```

---

## Summary

| Aspect              | Before                         | After                 |
| ------------------- | ------------------------------ | --------------------- |
| **Builder method**  | `.withDefinition(def)`         | `.withSchema(schema)` |
| **Definition type** | `{ id, name, tables, kv }`     | `{ id?, tables, kv }` |
| **Identity source** | Confusing (definition + Y.Doc) | Clear (Head Doc only) |
| **`client.name`**   | Exists (confusing origin)      | Removed               |
| **Schema source**   | Definition object              | Schema object         |

The refactor makes the API honest about where data comes from:

- **Identity** (name, icon, description) → Head Doc
- **Schema** (tables, kv) → Code or schema.json
- **Data** (rows, values) → Workspace Doc

---

## Complete Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           EPICENTER THREE-DOC ARCHITECTURE                               │
│                              (After Client Builder v2)                                   │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │                              REGISTRY DOC                                        │   │
│   │                              ────────────                                        │   │
│   │   Purpose: "Which workspaces exist on this device?"                             │   │
│   │   Y.Doc GUID: "registry"                                                        │   │
│   │   Scope: Personal (syncs across YOUR devices only)                              │   │
│   │                                                                                  │   │
│   │   Y.Map('workspaces')                                                           │   │
│   │     ├── "epicenter.whispering": true                                            │   │
│   │     ├── "epicenter.blog": true                                                  │   │
│   │     └── "my-notes": true                                                        │   │
│   │                                                                                  │   │
│   │   Files: registry.yjs, registry.json                                            │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                           │                                              │
│                                           │ getWorkspaceIds()                            │
│                                           ▼                                              │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │                              HEAD DOC (per workspace)                            │   │
│   │                              ───────────────────────                             │   │
│   │   Purpose: "What is this workspace? What version?"                              │   │
│   │   Y.Doc GUID: "{workspaceId}"                                                   │   │
│   │   Scope: Shared (syncs with collaborators)                                      │   │
│   │                                                                                  │   │
│   │   Y.Map('meta')                     Y.Map('epochs')                             │   │
│   │     ├── name: "Whispering"            └── "12345": 0                            │   │
│   │     ├── icon: { type: 'emoji',        └── "67890": 0                            │   │
│   │     │          value: '🎙️' }                                                    │   │
│   │     └── description: "Voice..."       getEpoch() → max(...) → 0                 │   │
│   │                                                                                  │   │
│   │   API: getMeta(), setMeta(), getEpoch(), bumpEpoch()                            │   │
│   │   Files: head.yjs, head.json                                                    │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                          │                                    │                          │
│            getMeta() ────┘                                    └──── getEpoch()           │
│                 │                                                       │                │
│                 ▼                                                       ▼                │
│   ┌──────────────────────────┐                        ┌──────────────────────────┐      │
│   │  IDENTITY                 │                        │  VERSION                  │      │
│   │  ────────                 │                        │  ───────                  │      │
│   │  name: "Whispering"       │                        │  epoch: 0                 │      │
│   │  icon: { emoji: '🎙️' }   │                        │                           │      │
│   │  description: "..."       │                        │  (increments on           │      │
│   │                           │                        │   schema migration)       │      │
│   │  Used for: UI display,    │                        │                           │      │
│   │  workspace picker         │                        │  Used for: Y.Doc GUID     │      │
│   └──────────────────────────┘                        └──────────────────────────┘      │
│                                                                    │                     │
│                                                                    │                     │
│                                                                    ▼                     │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │                           WORKSPACE DOC (per epoch)                              │   │
│   │                           ─────────────────────────                              │   │
│   │   Purpose: "Schema + Data for this workspace version"                           │   │
│   │   Y.Doc GUID: "{workspaceId}-{epoch}"                                           │   │
│   │   Scope: Shared (syncs with collaborators)                                      │   │
│   │                                                                                  │   │
│   │   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐                │   │
│   │   │ Y.Map('schema') │  │ Y.Map('kv')     │  │ Y.Map('tables') │                │   │
│   │   │ ─────────────── │  │ ───────────     │  │ ─────────────── │                │   │
│   │   │ tables:         │  │ theme: "dark"   │  │ recordings:     │                │   │
│   │   │   recordings:   │  │ language: "en"  │  │   "rec_001": {  │                │   │
│   │   │     name: ...   │  │                 │  │     id: "...",  │                │   │
│   │   │     fields: ... │  │                 │  │     title: ...  │                │   │
│   │   │ kv:             │  │                 │  │   }             │                │   │
│   │   │   theme: {...}  │  │                 │  │                 │                │   │
│   │   └─────────────────┘  └─────────────────┘  └─────────────────┘                │   │
│   │         │                     │                     │                           │   │
│   │         ▼                     ▼                     ▼                           │   │
│   │   schema.json           kv.json              (in Y.Doc only)                   │   │
│   │                                                                                  │   │
│   │   Files: workspace.yjs, schema.json, kv.json                                    │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│   CLIENT CREATION (New API)                                                             │
│   ─────────────────────────                                                             │
│                                                                                          │
│   // 1. Define schema in code (or load from schema.json)                                │
│   const schema = defineWorkspace({                                                      │
│     id: 'epicenter.whispering',                                                         │
│     tables: { recordings: table({ name: 'Recordings', fields: {...} }) },              │
│     kv: { theme: select({ options: ['light', 'dark'] }) }                              │
│   });                                                                                    │
│                                                                                          │
│   // 2. Get epoch from Head Doc                                                         │
│   const head = createHead(schema.id);                                                   │
│   await head.whenSynced;                                                                │
│   const epoch = head.getEpoch();                                                        │
│                                                                                          │
│   // 3. Create client with schema (NOT definition)                                      │
│   const client = createClient(schema.id, { epoch })                                     │
│     .withSchema(schema)           // ◄── NEW: just tables + kv                          │
│     .withExtensions({ sqlite, persistence });                                           │
│                                                                                          │
│   // 4. Identity comes from Head Doc (explicit)                                         │
│   const meta = head.getMeta();                                                          │
│   console.log(meta.name);         // "Whispering"                                       │
│                                                                                          │
│   // 5. Data operations via client                                                      │
│   client.tables.recordings.upsert({ id: '1', title: 'Meeting' });                       │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Appendix: Naming Conventions

| Term              | Meaning                                 | Example                                    |
| ----------------- | --------------------------------------- | ------------------------------------------ |
| **Schema**        | Table/KV type definitions (no identity) | `{ tables: {...}, kv: {...} }`             |
| **Definition**    | Schema + id (for convenience)           | `{ id: 'blog', tables: {...}, kv: {...} }` |
| **Identity/Meta** | Name, icon, description                 | `{ name: 'Blog', icon: {...} }`            |
| **Head Doc**      | Y.Doc storing identity + epoch          | `head.yjs`                                 |
| **Workspace Doc** | Y.Doc storing schema + data             | `workspace.yjs`                            |
| **Registry Doc**  | Y.Doc storing workspace list            | `registry.yjs`                             |
