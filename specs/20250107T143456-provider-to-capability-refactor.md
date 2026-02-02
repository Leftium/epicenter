# Provider to Capability Refactor

**Created**: 2025-01-07T14:34:56
**Status**: Complete

## Overview

Rename the "provider" concept to "capability" throughout the Epicenter codebase. This improves clarity by:

- Avoiding confusion with React providers, service providers, DI providers
- Better describing what these functions do: add capabilities to workspaces
- Enabling clearer documentation about what capabilities can do (listen to tables, persist KV, sync both, sync neither)

## Terminology Changes

| Old                     | New                        |
| ----------------------- | -------------------------- |
| `withProviders()`       | `withCapabilities()`       |
| `client.providers`      | `client.capabilities`      |
| `Provider` type         | `Capability` type          |
| `ProviderContext`       | `CapabilityContext`        |
| `ProviderPaths`         | `CapabilityPaths`          |
| `providerId`            | `capabilityId`             |
| `paths.provider`        | `paths.capability`         |
| `providers/` folder     | `capabilities/` folder     |
| `.epicenter/providers/` | `.epicenter/capabilities/` |

## Individual Capability Renames

| Old Name                      | New Name        | Reason                                        |
| ----------------------------- | --------------- | --------------------------------------------- |
| `sqliteProvider`              | `sqlite`        | Simpler, materializes tables→SQLite           |
| `markdownProvider`            | `markdown`      | Simpler, bidirectional sync to markdown files |
| `setupPersistence`            | `persistence`   | Consistency, stores YDoc to disk/IndexedDB    |
| `createWebsocketSyncProvider` | `websocketSync` | Clearer, handles real-time sync               |

## Files to Update

### Core Types (Batch 1: API Surface)

- `packages/epicenter/src/core/workspace/contract.ts` - `withProviders` → `withCapabilities`, `$providers` → `$capabilities`, `providers` → `capabilities`

### Core Types (Batch 2: Type Definitions)

- `packages/epicenter/src/core/provider.shared.ts` → rename to `capability.shared.ts`
  - `Provider` → `Capability`
  - `ProviderContext` → `CapabilityContext`
  - `Providers` → `Capabilities` (the exports type)
  - `providerId` → `capabilityId`
- `packages/epicenter/src/core/provider.ts` → rename to `capability.ts`

### Core Types (Batch 3: Paths)

- `packages/epicenter/src/core/types.ts`
  - `ProviderPaths` → `CapabilityPaths`
  - `ProviderDir` → `CapabilityDir`
  - `paths.provider` → `paths.capability`
- `packages/epicenter/src/core/paths.ts`
  - `getProviderDir` → `getCapabilityDir`
  - `buildProviderPaths` → `buildCapabilityPaths`
  - `'providers'` folder name → `'capabilities'`

### Folder Rename (Batch 4)

- `packages/epicenter/src/providers/` → `packages/epicenter/src/capabilities/`

### Individual Capabilities (Batch 5)

- `capabilities/sqlite/sqlite-provider.ts` → `capabilities/sqlite/index.ts` (merge)
  - `sqliteProvider` → `sqlite`
- `capabilities/markdown/markdown-provider.ts` → rename function
  - `markdownProvider` → `markdown`
- `capabilities/persistence/desktop.ts` and `web.ts`
  - Keep `setupPersistence` as-is or rename to `persistence`
- `capabilities/websocket-sync.ts`
  - `createWebsocketSyncProvider` → `websocketSync`

### Exports (Batch 6)

- `packages/epicenter/src/index.ts` - update all exports
- `packages/epicenter/src/core/workspace/index.ts` - update re-exports

### Examples (Batch 7)

- `examples/basic-workspace/epicenter.config.ts`
- `examples/content-hub/epicenter.config.ts` (if exists)

### Apps (Batch 8)

- `apps/tab-manager/src/entrypoints/background.ts`

## Implementation Batches

### Batch 1: API Method Rename

**Scope**: Rename `.withProviders()` → `.withCapabilities()` and `client.providers` → `client.capabilities`
**Files**: `contract.ts` only
**Risk**: Low - simple rename
**Commit**: `refactor(workspace): rename withProviders to withCapabilities`

### Batch 2: Core Type Renames

**Scope**: Rename `Provider` → `Capability`, `ProviderContext` → `CapabilityContext`
**Files**: `provider.shared.ts`, `provider.ts`, `contract.ts`
**Risk**: Medium - many imports to update
**Commit**: `refactor(core): rename Provider type to Capability`

### Batch 3: Path Type Renames

**Scope**: Rename `ProviderPaths` → `CapabilityPaths`, `paths.provider` → `paths.capability`
**Files**: `types.ts`, `paths.ts`, all capability implementations
**Risk**: Medium - affects runtime paths
**Commit**: `refactor(core): rename ProviderPaths to CapabilityPaths`

### Batch 4: Folder Rename

**Scope**: Rename `providers/` folder to `capabilities/`
**Files**: Folder + all imports
**Risk**: Medium - many import paths change
**Commit**: `refactor: rename providers folder to capabilities`

### Batch 5: Individual Capability Renames

**Scope**: Rename `sqliteProvider` → `sqlite`, etc.
**Files**: All capability implementations and their usages
**Risk**: Medium - breaking change for external users
**Commit**: `refactor(capabilities): rename individual capability functions`

### Batch 6: Update Exports

**Scope**: Update barrel exports in `index.ts`
**Files**: `index.ts`, `workspace/index.ts`
**Risk**: Low - depends on previous batches
**Commit**: `refactor: update capability exports`

### Batch 7: Update Examples

**Scope**: Update example configurations
**Files**: All files in `examples/`
**Risk**: Low
**Commit**: `docs(examples): update to use capabilities API`

### Batch 8: Update Apps

**Scope**: Update app code
**Files**: `apps/tab-manager/`
**Risk**: Low
**Commit**: `refactor(tab-manager): update to use capabilities API`

## JSDoc Improvements

Add comprehensive JSDoc to `CapabilityContext` explaining:

1. **Common Patterns**:
   - Persist entire YDoc (storage capability)
   - Sync tables to external store (materializer capability)
   - Sync KV to external cache
   - Real-time sync (sync capability)
   - Pure side-effect (logger, analytics)

2. **What Capabilities Can Return**:
   - `destroy?: () => void | Promise<void>`
   - `whenSynced?: Promise<unknown>`
   - Custom exports

3. **Examples** for each pattern

## Breaking Changes

This is a breaking change for users of the Epicenter library:

1. `withProviders()` → `withCapabilities()`
2. `client.providers` → `client.capabilities`
3. `@epicenter/hq/providers/*` → `@epicenter/hq/capabilities/*`
4. `sqliteProvider` → `sqlite`
5. `markdownProvider` → `markdown`
6. `createWebsocketSyncProvider` → `websocketSync`
7. `.epicenter/providers/` → `.epicenter/capabilities/`

## Migration Guide (for CHANGELOG)

```typescript
// Before
import { setupPersistence } from '@epicenter/hq/providers/persistence';
import { sqliteProvider } from '@epicenter/hq/providers/sqlite';
import { createWebsocketSyncProvider } from '@epicenter/hq/providers/websocket-sync';

const client = await workspace
  .withProviders({
    persistence: setupPersistence,
    sqlite: (c) => sqliteProvider(c),
    sync: createWebsocketSyncProvider({ url }),
  })
  .create();

client.providers.sqlite.db.select()...

// After
import { persistence } from '@epicenter/hq/capabilities/persistence';
import { sqlite } from '@epicenter/hq/capabilities/sqlite';
import { websocketSync } from '@epicenter/hq/capabilities/websocket-sync';

const client = await workspace
  .withCapabilities({
    persistence,
    sqlite: (c) => sqlite(c),
    sync: websocketSync({ url }),
  })
  .create();

client.capabilities.sqlite.db.select()...
```

## Checklist

- [x] Batch 1: API Method Rename (`withProviders` → `withCapabilities`)
- [x] Batch 2: Core Type Renames (`Provider` → `Capability`)
- [x] Batch 3: Path Type Renames (`ProviderPaths` → `CapabilityPaths`)
- [x] Batch 4: Folder Rename (`providers/` → `capabilities/`)
- [x] Batch 5: Individual Capability Renames
- [x] Batch 6: Update Exports
- [x] Batch 7: Update Examples
- [x] Batch 8: Update Apps
- [x] Add JSDoc documentation
- [ ] Update README (if needed)
- [ ] Test all changes (run full test suite)
