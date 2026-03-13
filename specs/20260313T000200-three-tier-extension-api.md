# Three-Tier Extension API

**Date**: 2026-03-13
**Status**: Draft
**Supersedes**: `20260219T195800-document-extension-api.md` (partially — the document extension API spec introduced `withDocumentExtension`; this spec redefines `withExtension` and adds `withWorkspaceExtension`)

## Problem

Developers forget to chain `.withDocumentExtension('persistence', indexeddbPersistence)` after `.withExtension('persistence', indexeddbPersistence)`. This causes document content (rich-text bodies) to silently not persist while workspace metadata (table rows, KV) does. Both Honeycrisp and Fuji shipped with this bug.

The root cause is an API design problem: the common case (persistence for both workspace and documents) requires two calls, while the uncommon case (workspace-only) requires one. The pit of success is inverted.

```
┌────────────────────────────────────────────────────────────────────────┐
│  CURRENT API — common case requires TWO calls                          │
│                                                                        │
│  .withExtension('persistence', idb)          ← workspace Y.Doc only   │
│  .withDocumentExtension('persistence', idb)  ← document Y.Docs only   │
│                                                                        │
│  Forgetting the second line = silent data loss                         │
└────────────────────────────────────────────────────────────────────────┘
```

## Design Decision

Three methods, each mapping to a clear intent:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  NEW API — common case requires ONE call                                │
│                                                                         │
│  .withExtension(key, factory)                 → both (90% case)        │
│  .withWorkspaceExtension(key, factory)        → workspace Y.Doc only   │
│  .withDocumentExtension(key, factory, opts?)  → document Y.Docs only   │
│                                                                         │
│  The unqualified name is the broadest scope. Qualifiers narrow it.      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why this naming

The unqualified form (`.withExtension`) is the default, used 90% of the time. Qualified forms (`.withWorkspaceExtension`, `.withDocumentExtension`) signal "this is scoped differently." This follows the same pattern as `import` vs `import type` — the common case is unadorned.

### Why extension factories don't need to know their scope

Extension factories already receive `{ ydoc }` and operate on whatever Y.Doc they get. `indexeddbPersistence` creates `new IndexeddbPersistence(ydoc.guid, ydoc)` — it doesn't know or care whether `ydoc` is the workspace doc or a content doc. The framework decides routing; the factory is scope-agnostic.

```typescript
// This function works identically for workspace and document Y.Docs.
// The guid differentiates the IndexedDB database name.
export function indexeddbPersistence({ ydoc }: { ydoc: Y.Doc }) {
    const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
    return {
        clearData: () => idb.clearData(),
        whenReady: idb.whenSynced,
        destroy: () => idb.destroy(),
    };
}
```

## API

### `withExtension(key, factory)` — both scopes

Registers the extension for the workspace Y.Doc AND all content Y.Docs. The factory fires once for the workspace doc (at build time) and once per content doc (at `documents.open()` time).

```typescript
createWorkspace(definition)
    .withExtension('persistence', indexeddbPersistence)      // workspace + all docs
    .withExtension('sync', createSyncExtension({...}))       // workspace + all docs
```

Workspace-level behavior is identical to the current `withExtension` — the factory receives the full `ExtensionContext` with typed access to prior extensions. Document-level behavior is identical to the current `withDocumentExtension` — the factory receives a `DocumentContext` with `{ id, ydoc, whenReady, extensions }`.

### `withWorkspaceExtension(key, factory)` — workspace Y.Doc only

Fires only for the workspace Y.Doc. Use when an extension is genuinely workspace-scoped and should NOT fire for content documents.

```typescript
createWorkspace(definition)
    .withExtension('persistence', indexeddbPersistence)
    .withWorkspaceExtension('analytics', analyticsExtension)    // workspace only
```

Same signature and context as the current `withExtension`.

### `withDocumentExtension(key, factory, options?)` — document Y.Docs only

Fires only for content Y.Docs. Supports optional `{ tags }` for targeting specific document types.

```typescript
createWorkspace(definition)
    .withExtension('persistence', indexeddbPersistence)
    .withDocumentExtension('snapshots', snapshotExtension)                        // all docs
    .withDocumentExtension('markdown', markdownExport, { tags: ['exportable'] })  // tagged docs only
```

Same signature as the current `withDocumentExtension`. Unchanged.

## Migration

### Before (current API)

```typescript
// apps/honeycrisp/src/lib/workspace.ts (BROKEN — documents don't persist)
export default createWorkspace(honeycrisp)
    .withExtension('persistence', indexeddbPersistence);

// apps/fs-explorer/src/lib/fs/fs-state.svelte.ts (correct but verbose)
const ws = createWorkspace({ id: 'fs-explorer', tables: { files: filesTable } })
    .withExtension('persistence', indexeddbPersistence)
    .withDocumentExtension('persistence', indexeddbPersistence, {
        tags: ['persistent'],
    });
```

### After (new API)

```typescript
// apps/honeycrisp/src/lib/workspace.ts (correct — one call covers both)
export default createWorkspace(honeycrisp)
    .withExtension('persistence', indexeddbPersistence);

// apps/fs-explorer/src/lib/fs/fs-state.svelte.ts
// NOTE: fs-explorer uses tags to limit document persistence to 'persistent' docs.
// withExtension fires for ALL docs, so we use withDocumentExtension for the tagged case.
const ws = createWorkspace({ id: 'fs-explorer', tables: { files: filesTable } })
    .withWorkspaceExtension('persistence', indexeddbPersistence)
    .withDocumentExtension('persistence', indexeddbPersistence, {
        tags: ['persistent'],
    });
```

### When each method applies

| Extension type          | Method                   | Example                                    |
|-------------------------|--------------------------|--------------------------------------------|
| Persistence (IndexedDB) | `withExtension`          | Always want both                           |
| WebSocket sync          | `withExtension`          | Both need server sync                      |
| BroadcastChannel        | `withExtension`          | Both need cross-tab sync                   |
| Snapshot/version history| `withDocumentExtension`  | Only documents need snapshots              |
| Markdown export         | `withDocumentExtension`  | Only documents render to markdown          |
| Tag-scoped persistence  | `withDocumentExtension`  | Only 'persistent' docs get IndexedDB       |
| Analytics/telemetry     | `withWorkspaceExtension` | Track workspace-level events, not per-doc  |

## Implementation

### `create-workspace.ts` changes

The `withExtension` method currently registers a factory for the workspace Y.Doc only. It needs to additionally push the factory into `documentExtensionRegistrations` (the array that `withDocumentExtension` currently writes to).

```
withExtension(key, factory):
  1. Call factory with workspace ExtensionContext (unchanged)
  2. Register resolved extension in workspace extension chain (unchanged)
  3. NEW: Push factory into documentExtensionRegistrations[] (same array withDocumentExtension uses)
```

The new `withWorkspaceExtension` method is the current `withExtension` behavior — workspace only, no document registration.

`withDocumentExtension` is unchanged.

### `types.ts` changes

Add `withWorkspaceExtension` to `WorkspaceClientBuilder`. Its signature is identical to the current `withExtension` signature. Then update `withExtension`'s JSDoc to document that it fires for both scopes.

### Extension key namespacing

Workspace extensions and document extensions already use independent key namespaces. With `withExtension` registering in both, the same key (e.g., `'persistence'`) appears in both namespaces — this is intentional and correct. The workspace extension context exposes workspace extension exports; the document extension context exposes document extension exports.

## Todo

- [ ] Rename current `withExtension` to `withWorkspaceExtension` in `create-workspace.ts`
- [ ] Add new `withExtension` that calls `withWorkspaceExtension` + pushes to `documentExtensionRegistrations`
- [ ] Add `withWorkspaceExtension` to `WorkspaceClientBuilder` type in `types.ts`
- [ ] Update `withExtension` JSDoc in `types.ts` to document both-scope behavior
- [ ] Update `apps/honeycrisp/src/lib/workspace.ts` — remove `.withDocumentExtension` (now redundant)
- [ ] Update `apps/fuji/src/lib/workspace.ts` — remove `.withDocumentExtension` (now redundant)
- [ ] Update `apps/fs-explorer/src/lib/fs/fs-state.svelte.ts` — change to `withWorkspaceExtension` + `withDocumentExtension` (tagged case)
- [ ] Update `apps/tab-manager/src/lib/workspace.ts` if applicable
- [ ] Update `apps/whispering/src/lib/workspace.ts` if applicable
- [ ] Update `create-workspace.test.ts` — add test that `withExtension` fires for both scopes
- [ ] Update `create-workspace.test.ts` — add test that `withWorkspaceExtension` fires only for workspace
- [ ] Update existing `withDocumentExtension` tests (unchanged behavior, just verify)
- [ ] Run `bun test` in `packages/workspace`
- [ ] Run `bun run check` across monorepo

## Design Notes

### Why not `{ scope }` option on a single method?

A single `withExtension(key, factory, { scope: 'both' | 'workspace' | 'documents' })` was considered. It has lower API surface (one method) but:

1. The scope option is invisible at a glance — you have to read the third argument to understand behavior.
2. Three methods with clear names are more scannable than one method with a hidden option.
3. `withDocumentExtension` already exists and has tag support — folding tags into a generic options bag alongside scope makes the options bag do too much.

### What about extension chain ordering?

`withExtension('persistence', ...)` fires the factory for the workspace doc during the builder chain (synchronous, like current `withExtension`). For document docs, it pushes the factory into the registrations array — these fire lazily when `documents.open()` is called (unchanged from current `withDocumentExtension` behavior).

This means workspace extensions resolve during the build chain (enabling typed `extensions` access), while document extensions resolve at open time (when the content Y.Doc exists). The ordering guarantee is: workspace persistence loads before document persistence, because `documents.open()` typically happens after `client.whenReady`.

### Will there ever be workspace-only extensions?

Rarely. The only clear cases are analytics/telemetry that track workspace-level events and shouldn't fire per-document, or workspace-level middleware that inspects the workspace Y.Doc structure. `withWorkspaceExtension` exists as an escape hatch — most consumers will never need it.
