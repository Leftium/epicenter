# Workspace as `defineDocument` — collapse the last asymmetry

**Date**: 2026-04-20
**Status**: Draft
**Depends on**: `specs/20260420T230100-collapse-document-framework.md`
**Follows**: `specs/20260420T220000-simplify-definedocument-primitive.md`, `specs/20260420T152026-definedocument-primitive.md`

## TL;DR

Today the workspace is a bespoke ~620-line builder: it constructs its own Y.Doc, wires tables / kv / awareness inline, bakes encryption into the store list, implements its own `dispose` / `whenReady` / `clearLocalData`, and exposes `applyEncryptionKeys` + `loadSnapshot` as top-level methods. After this spec the workspace is just another `defineDocument` instance — a user-owned builder that returns `{ ydoc, tables, kv, awareness, enc, whenReady, whenDisposed, [Symbol.dispose] }`, cached by the same primitive that caches content docs. One lifecycle machine for the whole system; workspaces and content docs are peers.

`createWorkspace` becomes `defineWorkspace(def)` — a thin factory-of-factories that closes over the table/kv/awareness definitions and returns a `defineDocument` instance with `gcTime: Infinity` (workspaces should not auto-evict). Encryption becomes an attachment (`attachEncryption(ydoc, { stores })`). Schema migration stays lazy + per-row (no change). `clearLocalData` and `applyEncryptionKeys` become methods on the `enc` attachment; `loadSnapshot` collapses to a one-line `Y.applyUpdate` at call sites.

## Motivation

### Current state

`packages/workspace/src/workspace/create-workspace.ts` (618 LOC) owns its own lifecycle machine end-to-end:

```text
createWorkspace(def)
├── new Y.Doc({ guid: id, gc })           ← construction
├── tableEntries = Object.entries(tableDefs).map(createEncryptedYkvLww + createTable)
├── kvStore = createEncryptedYkvLww(ydoc, KV_KEY)
├── awareness = attachAwareness(ydoc, awarenessDefs)
├── ydoc.on('destroy', () => dispose every encrypted store)
├── buildClient()                          ← builder with extension chain
│   ├── whenReady    = Promise.all(initPromises)
│   ├── dispose      = await documentCleanups; disposeLifo(extensionCleanups); ydoc.destroy()
│   ├── applyEncryptionKeys(keys)         ← top-level method; scans encryptedStores
│   ├── clearLocalData()                  ← top-level method; iterates clearLocalDataCallbacks
│   ├── loadSnapshot(update)              ← Y.applyUpdate(ydoc, update)
│   ├── withExtension() / withWorkspaceExtension() / withDocumentExtension()
│   └── withActions()                     ← terminal
```

Content docs meanwhile live in `packages/document/src/define-document.ts` (~280 LOC). After Spec B, `.withDocument`, `.withDocumentExtension`, `strategies.ts`, and `create-documents.ts` are gone — apps compose their own content-doc builders with `defineDocument`. Workspaces are the only holdout still using the old bespoke model.

### Problems

1. **Two construction APIs.** `new Y.Doc({ guid: 'x' })` + hand-rolled plumbing for workspace root; `defineDocument(build)` for content docs. Different mental models, different disposal semantics.
2. **Duplicated lifecycle logic.** `create-workspace.ts` reimplements the ready/dispose aggregation that `defineDocument` already owns — `Promise.all(initPromises)`, LIFO cleanup, teardown-on-init-failure, `Symbol.asyncDispose`.
3. **Encryption is hard-coded into the builder.** The encrypted-store list is an internal array closed over by `applyEncryptionKeys`; you can't swap in plaintext KV-LWW in tests without forking the workspace.
4. **`applyEncryptionKeys` / `clearLocalData` / `loadSnapshot` sit on the client.** Framework methods with no composition story.
5. **No refcount, no cache.** A second `createWorkspace(fuji)` builds a second Y.Doc for the same id.
6. **No `gcTime` discussion.** Because workspaces are explicit singletons, there's no way to express idle teardown.
7. **Asymmetry makes the system harder to reason about.** Two answers to "how does X dispose?"

### Desired state

```ts
function buildWorkspace(id: WorkspaceId) {
  const ydoc = new Y.Doc({ guid: id, gc: false });
  const tables    = attachTables(ydoc, tableDefs);
  const kv        = attachKv(ydoc, kvDef);
  const awareness = attachAwareness(ydoc, awarenessDef);
  const enc       = attachEncryption(ydoc, { stores: [...tables.stores, kv.store], workspaceId: id });

  return {
    ydoc, tables, kv, awareness, enc,
    whenReady:    Promise.resolve(),
    whenDisposed: Promise.all([tables.whenDisposed, kv.whenDisposed, enc.whenDisposed]).then(() => {}),
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}

export const workspaces = defineWorkspace({ id: 'epicenter.fuji', tables: { entries: entriesTable } });
// => DocumentFactory<WorkspaceId, WorkspaceBundle>   (gcTime: Infinity default)

using ws = workspaces.open('epicenter.fuji');
await ws.whenReady;
ws.tables.entries.set({ ... });
ws.enc.applyKeys(session.encryptionKeys);
ws.enc.clearLocalData();
```

Persistence and sync aren't in `buildWorkspace` — they're the **app's** responsibility via user-defined wrappers on top, matching the post-Spec-B content-doc pattern.

## Research Findings

### Original spec Phase 3 already sketched this

`specs/20260420T152026-definedocument-primitive.md` lines 368–435 (Phase 3):

> The workspace root Y.Doc becomes:
> ```ts
> const workspaceDoc = defineDocument(() => {
>   const ydoc = new Y.Doc({ guid: workspaceId });
>   return { ydoc, tables: createTables(ydoc, tableDefs), kv: createKvs(ydoc, kvDefs), awareness: attachAwareness(ydoc, ...) };
> });
> ```
> The workspace client is `workspaceDoc.get(workspaceId)` — i.e., the workspace becomes a singleton document handle.

That spec explicitly flagged this phase as not optional:

> The shape "workspace IS a defineDocument" must hold even if construction logic is delegated to internal helpers. Otherwise we keep the dual lifecycle and the spec is incomplete.

Spec A simplified the primitive; Spec B removed `.withDocument` et al.; this spec is the Phase 3 the original design promised.

### TanStack Query precedent

TanStack stores queries, mutations, and infinite queries in one unified `QueryCache` — not because the resources are identical, but because separating them encoded an asymmetry with no semantic justification. Same smell as workspace-vs-content-doc today.

### Builder composition over inheritance

`IndexeddbPersistence`, `WebsocketProvider`, `Awareness` all compose onto a `Y.Doc` you own. Our `attachIndexedDb`, `attachSync`, `attachAwareness` already follow that. Making the workspace bundle one more composed thing closes the loop.

## Design Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Workspace uses `defineDocument` | **Yes — same primitive.** | One cache, one lifecycle, one mental model. |
| 2 | Public factory name | **`defineWorkspace`** (repurposed from today's passthrough). | Matches `defineDocument` naming. |
| 3 | `createWorkspace` — keep? | **Drop.** `defineWorkspace(def).open(id)` replaces it. | Two entry points was already awkward. |
| 4 | Factory-of-factories vs closure | **Factory-of-factories.** | Preserves "declare schema once, use many times." |
| 5 | Default `gcTime` | **`Infinity`.** | Workspaces are session-long. Apps override for idle teardown. |
| 6 | Encryption | **`attachEncryption(ydoc, { stores, workspaceId })`.** | Extract from inline. Exposes `applyKeys`, `clearLocalData`, `stores`, `whenDisposed`. |
| 7 | `applyEncryptionKeys` → | **`bundle.enc.applyKeys(keys)`.** | Mid-life rotation works without Y.Doc reconstruction. |
| 8 | `clearLocalData` | **`bundle.enc.clearLocalData()`.** | Clearing = wiping encrypted blobs; that's encryption's concern. |
| 9 | `loadSnapshot` | **Dropped. Callers write `Y.applyUpdate(ws.ydoc, update)`.** | One line; ceremony. |
| 10 | Schema migration | **Stays lazy + per-row.** | No change. `table.get(id)` migrates on read. |
| 11 | Persistence / sync | **App-side wrappers.** Core builder is in-memory. | Matches Spec B content-doc pattern. |
| 12 | Extension chain | **Gone.** Composition in the builder/wrapper replaces it. | `.withExtension` was scaffolding for an asymmetric system. |
| 13 | `withActions` | **`attachActions(bundle, factory)` helper, not chainable.** | Small named helper for discoverability. |
| 14 | Handle lifecycle | **Inherits from `defineDocument`.** | `using ws = ...` works for free. |
| 15 | Multi-workspace | **Supported naturally by the cache.** | `factory.open('a')` and `factory.open('b')` are independent. |
| 16 | Awareness lifecycle | **Via `ydoc.destroy()` cascade.** | y-protocols registers its own `'destroy'` listener; unchanged. |

## Architecture

### Before

```text
┌─────────────────────────────────────────────────────────────┐
│  WORKSPACE                         CONTENT DOC              │
│  createWorkspace(def)              defineDocument(build)    │
│  ├── own Y.Doc construction        ├── user-owned build()   │
│  ├── own whenReady aggregation     ├── user composes promises│
│  ├── own dispose (LIFO)            ├── cache refcount+gcTime│
│  ├── own extension chain           ├── Symbol.dispose        │
│  ├── own clearLocalData list       └── no extension chain    │
│  ├── own applyEncryptionKeys                                 │
│  ├── loadSnapshot method                                     │
│  └── Symbol.asyncDispose                                     │
│  618 LOC framework builder          ~280 LOC primitive       │
└─────────────────────────────────────────────────────────────┘
         Two lifecycle machines. Different disposal.
```

### After

```text
┌─────────────────────────────────────────────────────────────┐
│         defineDocument<Id, T>(build, { gcTime })            │
│         ONE cache, ONE refcount, ONE disposer               │
└─────────────────────────────────────────────────────────────┘
              │                             │
              ▼                             ▼
   ┌─────────────────────────┐   ┌─────────────────────────┐
   │  WORKSPACE BUNDLE       │   │  CONTENT DOC BUNDLE     │
   │  { ydoc,                │   │  { ydoc,                │
   │    tables, kv,          │   │    content,             │
   │    awareness, enc,      │   │    idb, sync,           │
   │    whenReady,           │   │    whenReady,           │
   │    whenDisposed,        │   │    whenDisposed,        │
   │    [Symbol.dispose] }   │   │    [Symbol.dispose] }   │
   └─────────────────────────┘   └─────────────────────────┘
                    │                  │
                    └──── peers ───────┘
```

### Inside `defineWorkspace`

```text
defineWorkspace(def, opts?)
│
├── buildWorkspace = (id) => {
│     const ydoc = new Y.Doc({ guid: id, gc: def.gc ?? false });
│     const tables    = attachTables(ydoc, def.tables);
│     const kv        = attachKv(ydoc, def.kv);
│     const awareness = attachAwareness(ydoc, def.awareness);
│     const enc       = attachEncryption(ydoc, {
│       stores: [...tables.stores, kv.store], workspaceId: id,
│     });
│     return {
│       ydoc, tables, kv, awareness, enc,
│       whenReady:    Promise.resolve(),
│       whenDisposed: Promise.all([tables.whenDisposed, kv.whenDisposed, enc.whenDisposed]).then(() => {}),
│       [Symbol.dispose]() { ydoc.destroy(); },
│     };
│   }
└── return defineDocument(buildWorkspace, { gcTime: opts?.gcTime ?? Infinity });
```

### Full call-site example (fuji)

```ts
// apps/fuji/src/lib/workspace.ts
export const fujiWorkspaces = defineWorkspace({ id: 'epicenter.fuji', tables: { entries: entriesTable } });

export function createFujiWorkspace() {
  return {
    open(id: string) {
      const base = fujiWorkspaces.open(id);
      const idb  = attachIndexedDb(base.ydoc);
      const sync = attachSync(base.ydoc, { url: ..., getToken: ..., waitFor: idb.whenLoaded });
      return Object.assign(base, {
        idb, sync,
        actions: buildActions(base),
        whenReady: Promise.all([idb.whenLoaded, sync.whenConnected]).then(() => {}),
      });
    },
  };
}

using ws = createFujiWorkspace().open('epicenter.fuji');
await ws.whenReady;
ws.tables.entries.set({ ... });
ws.enc.applyKeys(session.encryptionKeys);
```

## Implementation Plan

### Phase 1 — Extract `attachEncryption`

- [ ] **1.1** Create `packages/workspace/src/shared/attach-encryption.ts`. Signature: `attachEncryption(ydoc, opts: { stores, workspaceId }): EncryptionAttachment`.
- [ ] **1.2** Exposes: `applyKeys(keys)`, `clearLocalData()`, `stores`, `whenDisposed`.
- [ ] **1.3** Move `lastKeysFingerprint` dedup from `create-workspace.ts:172` into the attachment.
- [ ] **1.4** Register `ydoc.on('destroy')` to dispose stores + resolve `whenDisposed`.
- [ ] **1.5** Port applyKeys / clearLocalData / fingerprint-dedup tests.

### Phase 2 — Introduce `attachTables` / `attachKv` helpers

- [ ] **2.1** `attachTables(ydoc, tableDefs)` → `{ helpers, stores, whenDisposed }`. Internal.
- [ ] **2.2** `attachKv(ydoc, kvDefs)` → `{ helper, store, whenDisposed }`. Internal.
- [ ] **2.3** Keep `createEncryptedYkvLww` usage internal to these helpers.

### Phase 3 — Rewrite `defineWorkspace`

- [ ] **3.1** Replace today's passthrough with factory-of-factories (`defineDocument(buildWorkspace, { gcTime: opts?.gcTime ?? Infinity })`).
- [ ] **3.2** `buildWorkspace` composes `attachTables`, `attachKv`, `attachAwareness`, `attachEncryption` and aggregates `whenDisposed`.
- [ ] **3.3** Type `WorkspaceBundle` to preserve all current typed access (`ws.tables.entries.set(...)`).

### Phase 4 — Migrate method surface

- [ ] **4.1** Remove top-level `applyEncryptionKeys` → `ws.enc.applyKeys`.
- [ ] **4.2** Remove top-level `clearLocalData` → `ws.enc.clearLocalData`.
- [ ] **4.3** Drop `loadSnapshot` and `encodedSize` — one-line call sites.
- [ ] **4.4** Keep `batch(fn)` as bundle helper: `ydoc.transact(fn)`.

### Phase 5 — Delete the old builder

- [ ] **5.1** Delete `create-workspace.ts` (618 LOC).
- [ ] **5.2** Delete `lifecycle.ts` (194 LOC) — extension chain is gone.
- [ ] **5.3** Remove `WorkspaceClientBuilder`, `ExtensionContext`, `SharedExtensionContext`, `RawExtension`, `ExtensionFactory` types.
- [ ] **5.4** Update barrel exports; `createWorkspace` no longer exported.

### Phase 6 — Migrate apps

- [ ] **6.1** `apps/fuji/src/lib/workspace.ts` → `defineWorkspace` + `createFujiWorkspace()` wrapper.
- [ ] **6.2** `apps/honeycrisp/src/lib/workspace/workspace.ts` → same.
- [ ] **6.3** `apps/tab-manager` — verify / migrate if present.
- [ ] **6.4** Update callers: `ws.applyEncryptionKeys(k)` → `ws.enc.applyKeys(k)`; `ws.clearLocalData()` → `ws.enc.clearLocalData()`; `ws.loadSnapshot(u)` → `Y.applyUpdate(ws.ydoc, u)`; `ws.extensions.sync` → `ws.sync`.

### Phase 7 — Verification

- [ ] **7.1** `bun test` in `packages/workspace`, `packages/document`. Pass.
- [ ] **7.2** `bun run build` at repo root. Clean.
- [ ] **7.3** `bun run typecheck` in `apps/fuji`, `apps/honeycrisp`. Clean.
- [ ] **7.4** Grep for `createWorkspace`, `WorkspaceClientBuilder`, `withExtension`, etc. — zero results outside archived specs.
- [ ] **7.5** Smoke test — create entry in fuji, reload, verify persistence + sync.

## Edge Cases

### Workspace re-acquire after disposal

`gcTime: Infinity` means refcount-0 keeps the entry live. `factory.open('id')` again is a cache hit; same Y.Doc, same state. `factory.close('id')` forces teardown with `whenDisposed` barrier.

### Partial failure during construction

If `attachKv` throws mid-`buildWorkspace`, no entry is cached (Spec A semantics). `attachTables` has already registered destroy listeners on the orphaned ydoc. Fix: `buildWorkspace` wraps in try/finally — on throw, `ydoc.destroy()` fires all teardown listeners, then rethrow.

### Encryption key rotation during live use

`ws.enc.applyKeys([v1])` then `ws.enc.applyKeys([v1, v2])`. Fingerprint dedup proceeds; keyring rebuilt; each store's `activateEncryption(keyring)` handles old-version decrypt + new-version encrypt. No Y.Doc reconstruction.

### `clearLocalData` while refcount > 1

Wipes stores in place; other handles see empty tables on next read. Matches today's non-refcount-aware semantics. Document loudly.

### Tab-level vs session-wide singleton

Session singleton: `factory.open(id)` never closed. Tab singleton with idle: `gcTime: 60_000` + `using` at route level. Multi-workspace: independent bundles per id.

### Schema migration timing

Stays lazy + per-row (`table.get(id)` triggers `migrate` if `_v` old). No change. If eager migration ever needed, fits in `whenReady`: `Promise.resolve().then(() => migrateAllRows(tables))`.

### Awareness disposal

y-protocols registers its own `doc.on('destroy')` — cascades automatically through `ydoc.destroy()` in `Symbol.dispose`.

## Open Questions

1. **`defineWorkspace` as alias or distinct function?**
   - **Recommendation**: distinct. Users shouldn't have to write `buildWorkspace` themselves.

2. **`gcTime: Infinity` default correct?**
   - **Recommendation**: yes. Workspace reconstruction is expensive (re-attach IDB, re-open sync, re-derive keys). Apps override.

3. **`clearLocalData` and refcount — coordinate or allow?**
   - **Recommendation**: allow. Matches today. Destructive-op docs.

4. **Multi-workspace — first-class?**
   - **Recommendation**: supported but not advertised. Test independence; no UI affordance in apps.

5. **`loadSnapshot` — keep as method?**
   - **Recommendation**: drop. Single-line call sites. Add back later if discoverability proves painful.

6. **`attachActions` as a named helper?**
   - **Recommendation**: yes; three-line typed wrapper around `Object.assign`. Not chainable.

7. **Persistence/sync in core or app wrapper?**
   - **Recommendation**: app wrapper. Matches Spec B; keeps core agnostic.

## Success Criteria

- [ ] `create-workspace.ts` and `lifecycle.ts` deleted.
- [ ] `defineWorkspace(def, opts?)` returns a `DocumentFactory<Id, WorkspaceBundle>`.
- [ ] `attach-encryption.ts` exports `attachEncryption`.
- [ ] `ws.enc.applyKeys(k)` replaces `ws.applyEncryptionKeys(k)`.
- [ ] `ws.enc.clearLocalData()` replaces `ws.clearLocalData()`.
- [ ] Bundle has no `loadSnapshot` or `encodedSize`.
- [ ] fuji and honeycrisp build and run; persistence + sync + encryption work.
- [ ] `bun test` and `bun run build` clean across repo.
- [ ] No references to `createWorkspace`, `WorkspaceClientBuilder`, `withExtension*`, `ExtensionContext`, `SharedExtensionContext`, `RawExtension`, `ExtensionFactory` outside archived specs.
- [ ] One lifecycle pattern (`defineDocument`) visible to new contributors.

## Non-Goals

- Changes to `@epicenter/document`'s primitive.
- Changes to content-doc builders from Spec B.
- Changes to sync protocol or crypto primitives.
- Changes to schema migration semantics.
- Reimplementing the extension chain.

## References

### Files modified

- `packages/workspace/src/workspace/define-workspace.ts` — rewritten
- `packages/workspace/src/shared/attach-encryption.ts` — new
- `packages/workspace/src/workspace/attach-tables.ts` — new
- `packages/workspace/src/workspace/attach-kv.ts` — new
- `packages/workspace/src/workspace/types.ts` — prune + introduce `WorkspaceBundle`
- `packages/workspace/src/index.ts` — barrel updates
- `apps/fuji/src/lib/workspace.ts` — migrate
- `apps/honeycrisp/src/lib/workspace/workspace.ts` — migrate

### Files deleted

- `packages/workspace/src/workspace/create-workspace.ts` (618 LOC)
- `packages/workspace/src/workspace/lifecycle.ts` (194 LOC)
- `packages/workspace/src/workspace/create-workspace.test.ts`

### Prior art

- `specs/20260420T152026-definedocument-primitive.md` — Phase 3 (lines 368–435)
- `specs/20260420T220000-simplify-definedocument-primitive.md` — primitive simplification
- `specs/20260420T230100-collapse-document-framework.md` — content-doc framework collapse (predecessor)
- TanStack Query unified cache

### Naming conventions

- `defineWorkspace(def, opts?)` — factory-of-factories returning a `DocumentFactory`
- `attachEncryption(ydoc, opts)` — encryption attachment
- `attachTables(ydoc, defs)`, `attachKv(ydoc, defs)` — internal
- `WorkspaceBundle` — replaces `WorkspaceClient`
- `ws.enc.applyKeys(keys)`, `ws.enc.clearLocalData()`
- `using ws = defineWorkspace(def).open(id)` — standard consumer pattern
