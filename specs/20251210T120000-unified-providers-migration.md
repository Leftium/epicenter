# Unified Providers Migration

**Status**: Approved
**Created**: 2025-12-10
**Goal**: Merge `indexes` and `providers` into a single unified `providers` map with consistent API

## Summary

Unify two separate concepts (providers and indexes) into a single `providers` map. All providers receive the same context and can optionally return exports.

### Key Changes

1. `schema` → `tables` in WorkspaceConfig
2. `Db<TSchema>` → `Tables<TSchema>` type alias
3. `db` → `tables` in all contexts
4. `providers` array → `providers` map (Record<string, Provider>)
5. `indexes` removed - merged into `providers`
6. Provider return type: `void` → `TExports | void`
7. `destroy()` is now optional in exports
8. Single-phase initialization (no ydoc/tables phases needed)

### Before vs After

**Before:**
```typescript
defineWorkspace({
  schema: { posts: ... },
  providers: [setupPersistence],
  indexes: {
    sqlite: (c) => sqliteIndex(c),
  },
  exports: ({ db, indexes }) => ({
    sqliteDb: indexes.sqlite.db,
  }),
})
```

**After:**
```typescript
defineWorkspace({
  tables: { posts: ... },
  providers: {
    persistence: setupPersistence,
    sqlite: sqliteProvider,
  },
  exports: ({ tables, providers }) => ({
    sqliteDb: providers.sqlite.db,
  }),
})
```

## Migration Plan

### Phase 1: Type System Updates

- [ ] Update `packages/epicenter/src/core/db/core.ts`
  - Rename `Db<TSchema>` to `Tables<TSchema>` (no deprecated alias)

- [ ] Update `packages/epicenter/src/core/provider.ts`
  - Expand `ProviderContext` to include `schema`, `tables`, `providerId`
  - Change `Provider` return type to allow exports
  - Add `ProviderExports` type (optional destroy)

- [ ] Delete `packages/epicenter/src/core/indexes.ts` entirely

- [ ] Update `packages/epicenter/src/core/workspace/config.ts`
  - Rename `schema` to `tables` in `WorkspaceConfig`
  - Remove `indexes` from `WorkspaceConfig`
  - Change `providers` from `Provider[]` to `Record<string, Provider>`
  - Update `exports` context: `indexes` → `providers`, `db` → `tables`

### Phase 2: Initialization Logic Updates

- [ ] Update `packages/epicenter/src/core/workspace/client.shared.ts`
  - Single-phase initialization:
    1. Create ydoc
    2. Create tables from ydoc
    3. Initialize ALL providers with full context
    4. Collect exports from providers that return them
    5. Pass providers object to exports factory
  - Update cleanup to handle optional destroy

### Phase 3: Provider Implementation Updates

- [ ] Update `packages/epicenter/src/providers/persistence/desktop.ts`
  - Update to use new `ProviderContext` shape
  - Can ignore `schema` and `tables` (only needs `ydoc`)

- [ ] Update `packages/epicenter/src/providers/persistence/web.ts`
  - Same changes as desktop.ts

- [x] ~~Update `packages/epicenter/src/providers/hocuspocus.ts` (if exists)~~ (removed - replaced by websocket-sync)

### Phase 4: Index → Provider Migration

- [ ] Update `packages/epicenter/src/indexes/sqlite/sqlite-index.ts`
  - Rename file to `sqlite-provider.ts`
  - Change export from `sqliteIndex` to `sqliteProvider`
  - Update to use `ProviderContext` instead of `IndexContext`
  - Use `tables` instead of `db` from context

- [ ] Update `packages/epicenter/src/indexes/markdown/markdown-index.ts`
  - Rename file to `markdown-provider.ts`
  - Change export from `markdownIndex` to `markdownProvider`
  - Update to use `ProviderContext` instead of `IndexContext`
  - Use `tables` instead of `db` from context

- [ ] Update index barrel files
  - Export only new names (no deprecated aliases)

### Phase 5: Export Updates

- [ ] Update `packages/epicenter/src/index.shared.ts`
  - Export new types (`ProviderContext`, `ProviderExports`, `Tables`, etc.)
  - Remove old exports (`IndexContext`, `IndexExports`, `Db`, etc.)

- [ ] Update `packages/epicenter/src/index.node.ts` and `index.browser.ts`
  - Ensure platform-specific exports are updated

### Phase 6: Example Updates

- [ ] Update `examples/basic-workspace/epicenter.config.ts`
  - Change `schema` to `tables`
  - Move `indexes` into `providers` map
  - Change `setupPersistence` from array item to map entry
  - Update exports to use `providers.sqlite` instead of `indexes.sqlite`

- [ ] Update `examples/content-hub/` workspace files
  - Same changes for all workspaces

- [ ] Update `examples/stress-test/epicenter.config.ts`

### Phase 7: Test Updates

- [ ] Update `packages/epicenter/src/core/workspace.test.ts`
  - Update test workspace configs to use new shape
  - Test providers with and without exports

- [ ] Update `packages/epicenter/src/core/epicenter.test.ts`
  - Same changes

- [ ] Update `examples/basic-workspace/*.test.ts`
  - Update to use new API

### Phase 8: Documentation Updates

- [ ] Update `packages/epicenter/README.md`
- [ ] Update JSDoc comments throughout

## Type Definitions (Target State)

```typescript
// Provider exports (optional destroy)
type ProviderExports = {
  destroy?: () => void | Promise<void>;
  [key: string]: unknown;
};

// Unified Provider type
type Provider<
  TSchema extends WorkspaceSchema = WorkspaceSchema,
  TExports extends ProviderExports = ProviderExports
> = (context: ProviderContext<TSchema>) => TExports | void | Promise<TExports | void>;

// Unified context
type ProviderContext<TSchema extends WorkspaceSchema = WorkspaceSchema> = {
  id: string;              // Workspace ID
  providerId: string;      // This provider's key in the map
  ydoc: Y.Doc;
  schema: TSchema;
  tables: Tables<TSchema>;
  storageDir: StorageDir | undefined;
  epicenterDir: EpicenterDir | undefined;
};

// Renamed type alias (no deprecated Db alias)
type Tables<TSchema extends WorkspaceSchema> = ReturnType<typeof createEpicenterDb<TSchema>>;
```

## Backward Compatibility

**None.** Clean break - no deprecated aliases. Delete old types and exports entirely:
- Delete `Db<T>` → only `Tables<T>` exists
- Delete `IndexContext<T>` → only `ProviderContext<T>` exists
- Delete `IndexExports` → only `ProviderExports` exists
- Delete `sqliteIndex` → only `sqliteProvider` exists
- Delete `markdownIndex` → only `markdownProvider` exists
- Delete `indexes.ts` entirely after migration
- No `schema` in config → only `tables`
- No `indexes` in config → only `providers`

## Review

_To be filled after implementation_
