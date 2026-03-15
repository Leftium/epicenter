# Encryption Hygiene — Lifecycle Rename, Sign-Out Wipe, Type Safety, Documentation

**Date**: 2026-03-14
**Status**: Approved

## Problem

Several code smells and missing behaviors across the encryption and lifecycle systems:

1. **`destroy` is misnamed** — Every `destroy()` implementation in the codebase means "release resources" (close connections, remove listeners). None delete data. The name implies violence but the behavior is cleanup. TC39's Explicit Resource Management standard uses `dispose` for exactly this. The codebase already uses `Symbol.asyncDispose`.

2. **No formal protocol for data wiping** — `clearData()` exists as an ad-hoc export on `indexeddbPersistence` only. When `signOut()` needs to wipe persisted data, there's no typed protocol to discover which extensions support it.

3. **No hard sign-out** — `lock()` clears the key but preserves the decrypted cache and IndexedDB persistence. On explicit sign-out, we should wipe local state (Bitwarden/1Password model: lock = keep data, logout = wipe data).

4. **Untyped custom session cast** — `auth.svelte.ts` uses `as Record<string, unknown>` to read `encryptionKey` from Better Auth's `customSession` response. Fragile — if the field name changes server-side, the client silently reads `undefined` with no type error.

5. **Undocumented encryption behaviors** — Plaintext→encrypted migration and fire-and-forget gap are correct but undocumented.

## Design

### New Lifecycle Protocol

```
Before:  { whenReady, destroy }
After:   { whenReady, dispose, clearData? }
```

| Method | Meaning | Data | Instance after |
|---|---|---|---|
| `dispose()` | Release resources (connections, listeners, handles) | Kept | Unusable |
| `clearData()` | Wipe persisted data (optional, persistence extensions only) | Wiped | Still needs `dispose()` |

### WorkspaceClient Surface

| Method | What it does |
|---|---|
| `dispose()` | LIFO dispose all extensions, destroy Y.Doc |
| `clearLocalData()` | `lock()` → `clearData()` on all extensions (client stays alive) |
| `[Symbol.asyncDispose]()` | Alias for `dispose()` |

No `destroy` anywhere in the API vocabulary.

## Plan

### Wave 1: Rename `destroy` → `dispose` (mechanical)

All changes are pure renames — no behavior changes.

**Core types and implementation:**
- [ ] `packages/workspace/src/workspace/lifecycle.ts` — `destroy` → `dispose` in type + JSDoc + `defineExtension()`
- [ ] `packages/workspace/src/workspace/types.ts` — all `destroy` refs in `Extension`, `ExtensionFactory`, `DocumentExtensionRegistration`, `WorkspaceClient`, `WorkspaceClientBuilder`
- [ ] `packages/workspace/src/workspace/create-workspace.ts` — `destroyLifo` → `disposeLifo`, internal var names, method implementations
- [ ] `packages/workspace/src/workspace/create-document.ts` — internal destroy refs
- [ ] `packages/workspace/src/workspace/index.ts` — re-exports if any

**Extensions:**
- [ ] `packages/workspace/src/extensions/sync/web.ts` — `destroy:` → `dispose:`
- [ ] `packages/workspace/src/extensions/sync/desktop.ts` — `destroy()` → `dispose()` in return objects
- [ ] `packages/workspace/src/extensions/sync/broadcast-channel.ts` — `destroy()` → `dispose()`
- [ ] `packages/workspace/src/extensions/sync.ts` — `destroy()` → `dispose()`

**Sync client:**
- [ ] `packages/sync-client/src/types.ts` — `destroy` → `dispose` on `SyncProvider`
- [ ] `packages/sync-client/src/provider.ts` — `destroy()` → `dispose()` method

**Apps (consumers):**
- [ ] `apps/tab-manager/src/lib/state/chat-state.svelte.ts`
- [ ] `apps/tab-manager/src/lib/state/saved-tab-state.svelte.ts`
- [ ] `apps/tab-manager-markdown/src/markdown-persistence-extension.ts`
- [ ] `apps/tab-manager-markdown/src/index.ts`
- [ ] `apps/opensidian/src/lib/fs/fs-state.svelte.ts`
- [ ] `apps/whispering/src/lib/state/vad-recorder.svelte.ts`
- [ ] `apps/whispering/src/routes/transform-clipboard/transformClipboardWindow.tauri.ts`
- [ ] `apps/honeycrisp/src/lib/workspace.ts`
- [ ] `apps/api/worker-configuration.d.ts` (if referencing our destroy)

**.svelte files:**
- [ ] `apps/opensidian/src/lib/components/ContentEditor.svelte`
- [ ] `apps/whispering/src/lib/components/TransformationPickerBody.svelte`
- [ ] `apps/honeycrisp/src/lib/components/Editor.svelte`
- [ ] `apps/fuji/src/lib/components/EntryEditor.svelte`

**Tests:**
- [ ] `packages/workspace/src/workspace/create-workspace.test.ts`
- [ ] `packages/workspace/src/workspace/create-document.test.ts`
- [ ] `packages/workspace/src/workspace/define-workspace.test.ts`
- [ ] `packages/workspace/src/workspace/benchmark.test.ts`
- [ ] `packages/workspace/src/extensions/sync.test.ts`
- [ ] `packages/sync-client/src/provider.test.ts`

**Scripts:**
- [ ] `packages/workspace/scripts/stress-test-static.ts`
- [ ] `packages/workspace/scripts/reddit-import-test.ts`

**Docs (only where referencing our API, not general prose):**
- [ ] Docs referencing `destroy()` as our API method — update to `dispose()`

### Wave 2: Add `clearData` to Lifecycle + `clearLocalData()` to WorkspaceClient

- [ ] Add optional `clearData` to `Lifecycle` type in `lifecycle.ts`
- [ ] Update `defineExtension()` to pass through `clearData` if present
- [ ] Update `Extension<T>` type to include optional `clearData`
- [ ] Add `clearLocalData()` to `WorkspaceClient` in `create-workspace.ts`:
  - Calls `lock()`
  - Iterates extensions in LIFO order, calls `clearData()` on those that have it
  - Does NOT call `dispose()` — client stays alive for next sign-in
- [ ] Update `WorkspaceClient` type in `types.ts` to include `clearLocalData()`
- [ ] Add test for `clearLocalData()` — verify mode is locked, clearData called, client still usable
- [ ] Add `clearData` to desktop persistence (`desktop.ts`) — delete SQLite file

### Wave 3: Fix Auth Type Safety

- [x] Define shared session type for `encryptionKey` + `keyVersion`
- [x] Remove `as Record<string, unknown>` cast in `auth.svelte.ts`

### Wave 4: Document Encryption Behaviors

- [x] JSDoc on `unlock()` — plaintext entries stay plaintext, new writes encrypt, mixed data handled
- [x] JSDoc on `lock()` — soft lock (Bitwarden model), key cleared, cache stays, for hard wipe use `clearLocalData()`
- [x] Inline comment on `refreshEncryptionKey()` — fire-and-forget gap

## Technical Details

### ast-grep Strategy for Wave 1

Mechanical renames that ast-grep can handle:
- Method definitions: `destroy() {` → `dispose() {`
- Property shorthand: `destroy,` → `dispose,`
- Return object: `destroy: () =>` → `dispose: () =>`
- Type property: `destroy:` → `dispose:` in type definitions
- Method calls: `.destroy()` → `.dispose()`

Renames that need manual handling:
- JSDoc references to `destroy`
- Variable names like `destroyLifo`, `extensionCleanups` with `destroy` in comments
- String literals in test descriptions containing "destroy"

### IndexedDB Clearing

`indexeddbPersistence` already exposes `clearData()`. It becomes formally part of the lifecycle protocol:

```typescript
export function indexeddbPersistence({ ydoc }: { ydoc: Y.Doc }) {
  const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
  return {
    clearData: () => idb.clearData(),  // lifecycle protocol
    whenReady: idb.whenSynced,
    dispose: () => idb.destroy(),      // was destroy, now dispose
  };
}
```

### `clearLocalData()` Implementation

```typescript
async clearLocalData() {
  this.lock();
  // LIFO clearData on extensions that support it
  for (let i = extensionEntries.length - 1; i >= 0; i--) {
    await extensionEntries[i]?.clearData?.();
  }
  // No dispose() — client stays alive for next sign-in
}
```

## Files Changed

~29 TypeScript files, ~4 Svelte files, select docs.
Full list in Wave 1 checklist above.

## Deliberately Excluded

- Re-encrypting legacy plaintext data on unlock — separate migration feature
- KeyCache clearing in `clearLocalData()` — interface not yet implemented
- Renaming `ydoc.destroy()` — that's Yjs's API, not ours
- Docs that use "destroy" in general prose (not our API) — left as-is
