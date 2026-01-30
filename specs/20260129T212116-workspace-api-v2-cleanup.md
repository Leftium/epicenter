# Workspace API V2 Cleanup

**Status**: Planned  
**Created**: 2026-01-29  
**Breaking Change**: Yes

## Summary

Remove deprecated workspace APIs and consolidate on the modern patterns:

- `defineWorkspaceV2` becomes `defineWorkspace`
- `createClient` removed in favor of `createCellWorkspace`
- Clean up all JSDoc examples and documentation

## Motivation

The codebase currently has two parallel APIs:

| Old (Deprecated)  | New (Preferred)       | Purpose                   |
| ----------------- | --------------------- | ------------------------- |
| `defineWorkspace` | `defineWorkspaceV2`   | Define workspace schema   |
| `createClient`    | `createCellWorkspace` | Create workspace instance |

This creates confusion and maintenance burden. The "V2" suffix is awkward and the old APIs are already marked `@deprecated`.

## Scope

### Files to Modify

#### Core Implementation (4 files)

- [ ] `src/core/workspace/workspace.ts`
  - Remove `defineWorkspace` function (lines 390-397)
  - Rename `defineWorkspaceV2` to `defineWorkspace`
  - Remove `createClient` function (lines 499-508)
  - Remove `createClientBuilder` function (lines 517-565)
  - Update all JSDoc examples

- [ ] `src/core/workspace/node.ts`
  - Remove `createClient` async wrapper (lines 383-439)
  - Update all JSDoc examples to use `createCellWorkspace`
  - Keep `defineWorkspace` re-export (points to renamed function)

- [ ] `src/core/workspace/index.ts`
  - Remove `createClient` export
  - Keep `defineWorkspace` export (now points to V2)

- [ ] `src/index.ts`
  - Remove deprecated exports with `@deprecated` JSDoc
  - Keep `defineWorkspace` (now the V2 version)
  - Keep `createCellWorkspace` export

#### Static Module (3 files)

- [ ] `src/static/define-workspace.ts`
  - This is a DIFFERENT `defineWorkspace` for the static workspace system
  - Keep as-is (different purpose)

- [ ] `src/static/define-workspace.test.ts`
  - Keep as-is (tests static version)

- [ ] `src/static/types.ts`
  - Update comment referencing `defineWorkspace()`

#### Documentation Updates (JSDoc examples in 10+ files)

- [ ] `src/extensions/persistence/web.ts` - 7 example updates
- [ ] `src/extensions/persistence/desktop.ts` - 3 example updates
- [ ] `src/extensions/sqlite/sqlite.ts` - 2 example updates
- [ ] `src/extensions/websocket-sync.ts` - 5 example updates
- [ ] `src/extensions/revision-history/local.ts` - 3 example updates
- [ ] `src/extensions/revision-history/index.ts` - 2 example updates
- [ ] `src/server/server.ts` - 2 example updates
- [ ] `src/core/docs/head-doc.ts` - 2 example updates
- [ ] `src/core/docs/workspace-doc.ts` - 1 example update
- [ ] `src/cell/extensions.ts` - 2 example updates

#### Test Files (verify still work)

- [ ] `src/cell/create-cell-workspace.test.ts` - Already uses `createCellWorkspace`
- [ ] `src/cli/integration.test.ts` - Uses old pattern, needs update

## Implementation Plan

### Phase 1: Rename defineWorkspaceV2 to defineWorkspace

```typescript
// Before (workspace.ts)
export function defineWorkspaceV2<...>(...): WorkspaceDefinitionV2<...> { ... }
export function defineWorkspace<...>(...): WorkspaceDefinition<...> { ... }  // @deprecated

// After (workspace.ts)
export function defineWorkspace<...>(...): WorkspaceDefinition<...> { ... }  // The V2 version
// Old defineWorkspace removed entirely
```

Also rename the type:

```typescript
// Before
export type WorkspaceDefinitionV2<...> = { ... }

// After
export type WorkspaceDefinition<...> = { ... }  // Same as V2 was
```

### Phase 2: Remove createClient

The `createClient` pattern is replaced by `createCellWorkspace`:

```typescript
// Old pattern
const client = createClient(head)
	.withDefinition(definition)
	.withExtensions({ persistence });

// New pattern
const workspace = createCellWorkspace({ headDoc, definition }).withExtensions({
	persistence,
});
```

Remove:

- `createClient()` function
- `createClientBuilder()` internal function
- `ClientBuilder` type
- Node.js async `createClient()` wrapper

### Phase 3: Update All JSDoc Examples

Search and replace in all documentation:

- `createClient(head).withDefinition(definition).withExtensions({})`
- `defineWorkspace({ tables: {...}, kv: {} })`

Replace with:

- `createCellWorkspace({ headDoc, definition }).withExtensions({})`
- `defineWorkspace({ name: '...', tables: [...], kv: [...] })`

### Phase 4: Verify Tests Pass

Run full test suite to ensure nothing breaks.

## Migration Guide (for external consumers)

### Before

```typescript
import { defineWorkspace, createClient, createHeadDoc } from '@epicenter/hq';

const definition = defineWorkspace({
  name: 'Blog',
  tables: { posts: table({ id: 'posts', fields: [...] }) },
  kv: {},
});

const head = createHeadDoc({ workspaceId: 'blog' });
const client = createClient(head)
  .withDefinition(definition)
  .withExtensions({ persistence });
```

### After

```typescript
import { defineWorkspace, createCellWorkspace, createHeadDoc } from '@epicenter/hq';

const definition = defineWorkspace({
  name: 'Blog',
  description: '',
  icon: null,
  tables: [table({ id: 'posts', fields: [...] })],
  kv: [],
});

const headDoc = createHeadDoc({ workspaceId: 'blog' });
const workspace = createCellWorkspace({ headDoc, definition })
  .withExtensions({ persistence });
```

Key differences:

1. `tables` and `kv` are now arrays, not objects
2. `createCellWorkspace` takes `{ headDoc, definition }` object
3. No separate `.withDefinition()` step

## Todo Checklist

- [ ] Phase 1: Rename `defineWorkspaceV2` to `defineWorkspace`
  - [ ] Rename function in `workspace.ts`
  - [ ] Rename `WorkspaceDefinitionV2` type to `WorkspaceDefinition`
  - [ ] Remove old `defineWorkspace` function
  - [ ] Update exports in `index.ts` and `workspace/index.ts`

- [ ] Phase 2: Remove `createClient`
  - [ ] Remove `createClient` from `workspace.ts`
  - [ ] Remove `createClientBuilder` from `workspace.ts`
  - [ ] Remove `ClientBuilder` type
  - [ ] Remove Node.js `createClient` wrapper from `node.ts`
  - [ ] Update exports

- [ ] Phase 3: Update JSDoc examples
  - [ ] `extensions/persistence/web.ts`
  - [ ] `extensions/persistence/desktop.ts`
  - [ ] `extensions/sqlite/sqlite.ts`
  - [ ] `extensions/websocket-sync.ts`
  - [ ] `extensions/revision-history/local.ts`
  - [ ] `extensions/revision-history/index.ts`
  - [ ] `server/server.ts`
  - [ ] `core/docs/head-doc.ts`
  - [ ] `core/docs/workspace-doc.ts`
  - [ ] `cell/extensions.ts`

- [ ] Phase 4: Update tests
  - [ ] `cli/integration.test.ts`

- [ ] Phase 5: Verify
  - [ ] Run `bun run typecheck`
  - [ ] Run `bun test`

## Notes

### Static vs Cell Workspace

There are TWO different workspace systems:

1. **Cell Workspace** (`src/cell/`) - Notion-like, cell-level CRDT, advisory schema
2. **Static Workspace** (`src/static/`) - Typed, versioned schemas with migrations

Both have a `defineWorkspace` function but they serve different purposes:

- `src/core/workspace/workspace.ts` - For Cell Workspace (this spec)
- `src/static/define-workspace.ts` - For Static Workspace (keep as-is)

### Breaking Change Justification

This is a breaking change but justified because:

1. Old APIs already marked `@deprecated`
2. New APIs are cleaner and more intuitive
3. Reduces API surface area and confusion
4. No external consumers yet (internal project)
