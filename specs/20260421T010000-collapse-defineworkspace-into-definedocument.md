# Collapse `defineWorkspace` into `defineDocument`

**Date**: 2026-04-21
**Status**: Draft
**Author**: AI-assisted
**Branch**: braden-w/document-primitive

## Overview

Delete the `defineWorkspace` convenience wrapper. Apps and packages compose their workspace the same way they already compose content docs — one `defineDocument(() => { ... })` closure that constructs the Y.Doc and calls `attach*` primitives inline. Fix three invariant/ergonomic issues in the attach primitives that are currently masked by the wrapper.

## Motivation

### Current State

A fuji-style app has two files:

```ts
// apps/fuji/src/lib/workspace.ts
export const fuji = defineWorkspace({
  id: 'epicenter.fuji',
  tables: { entries: entriesTable },
});

// apps/fuji/src/lib/client.ts
const base = fuji.open('epicenter.fuji');
const idb = attachIndexedDb(base.ydoc);
attachBroadcastChannel(base.ydoc);
const sync = attachSync(base.ydoc, { url, getToken, waitFor: idb.whenLoaded });
export const workspace = Object.assign(base, {
  idb, sync,
  actions: createFujiActions(base.tables),
  whenReady: idb.whenLoaded,
});
```

The same app has content-doc factories that look totally different structurally:

```ts
// apps/fuji/src/lib/entry-content-docs.ts
export const entryContentDocs = defineDocument((entryId: EntryId) => {
  const ydoc = new Y.Doc({ guid: docGuid({ ... }), gc: false });
  const content = attachRichText(ydoc);
  const idb = attachIndexedDb(ydoc);
  const sync = attachSync(ydoc, { ... });
  return { ydoc, content, whenReady: idb.whenLoaded, [Symbol.dispose]() { ydoc.destroy(); } };
});
```

Two shapes. Workspaces split into "define schema" + "wire in client" + `Object.assign`. Content docs compose everything in one closure. Same framework, two patterns.

### Problems

1. **Asymmetric mental model.** Workspaces use `defineWorkspace(schema).open(id)` and then the caller glues on attachments. Content docs just use `defineDocument(() => ... compose inline ...)`. One primitive would be less to learn and less to maintain.

2. **`Object.assign` ceremony.** The whole purpose of the wrapper is to return a "base" that callers immediately `Object.assign` onto. The base's contract doesn't survive the merge; components read `workspace.sync` or `workspace.idb` which live on the extension, not the base.

3. **Hidden store aggregation.** `defineWorkspace` calls `attachEncryption(ydoc, { stores: [...tables.stores, kv.store] })`. Once users compose directly, that array-concat is exposed. Forget `kv.store` and writes go plaintext silently — no type error, no runtime error. (Verified by audit: `packages/workspace/src/workspace/define-workspace.ts:184–186`.)

4. **Inconsistent lifecycle naming.** Every primitive picks its own noun:
   - `attachIndexedDb` → `whenLoaded`
   - `attachSync` → `whenConnected`
   - `attachBroadcastChannel` → only `whenDisposed`
   - User bundles → `whenReady` (convention)

   In the wrapper world, apps compose once. In the direct world, every app composes — and every app picks which noun to expose.

5. **Reentrance is a silent data-loss bug.** `attachTable(ydoc, 'posts', def)` called twice returns two wrappers over the same `Y.Array`. The second wrapper has no knowledge of the first's in-memory state; mutations through one don't appear on the other. Today this is impossible because the wrapper composes tables exactly once. In the direct world, a stray second `attachTable` in a test helper or diagnostic tool corrupts reads. (Audit confirmed: `packages/document/src/attach-table.ts`.)

### Desired State

One file per workspace, same shape as a content doc:

```ts
// apps/fuji/src/lib/client.ts
const fuji = defineDocument((id: string) => {
  const ydoc = new Y.Doc({ guid: id, gc: false });

  const tables = attachTables(ydoc, fujiTables);
  const kv = attachKv(ydoc, {});
  const awareness = attachAwareness(ydoc, {});
  const enc = attachEncryption(ydoc, { tables, kv });  // ← introspects stores

  const idb = attachIndexedDb(ydoc);
  attachBroadcastChannel(ydoc);
  const sync = attachSync(ydoc, { url, getToken, waitFor: idb.whenReady, awareness: awareness.raw });

  return {
    id, ydoc, tables: tables.helpers, kv: kv.helper, awareness, enc, idb, sync,
    actions: createFujiActions(tables.helpers),
    batch: (fn) => ydoc.transact(fn),
    whenReady: idb.whenReady,
    whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed, enc.whenDisposed]).then(() => {}),
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}, { gcTime: Infinity });

export const workspace = fuji.open('epicenter.fuji');
```

No wrapper, no `Object.assign`, no separate definition file. The return object IS the workspace contract.

## Research Findings

### Prior rejections in this direction

`specs/20260420T230100-collapse-document-framework.md` and `specs/20260420T230200-workspace-as-definedocument.md` both considered "keep a thin wrapper for workspaces" and landed on: workspaces ARE documents with the same cache/refcount semantics. The spec explicitly flagged `.withDocument` sugar as "rejected because if `defineDocument` lets users own the construction closure directly, the entire reason `.withDocument` exists disappears." This spec extends that logic one more layer: the same reasoning applies to `defineWorkspace`. It's ~33 lines of body doing attach composition plus encryption store aggregation. Every line is something the caller could do explicitly.

### API family audit

Surveyed every `attach*` primitive across `packages/document/src/` and `packages/workspace/src/`. Findings below.

**Lifecycle promise naming is not uniform:**

| Primitive | Ready-style promise | Teardown promise |
| --- | --- | --- |
| `attachIndexedDb` | `whenLoaded` | `whenDisposed` |
| `attachFilesystemPersistence` | `whenLoaded` | `whenDisposed` |
| `attachSync` | `whenConnected` | `whenDisposed` |
| `attachBroadcastChannel` | — | `whenDisposed` |
| `attachEncryption` | — | `whenDisposed` |
| `attachTables` / `attachKv` / `attachAwareness` | — | — (relies on ydoc cascade) |

Apps writing the `whenReady` aggregation manually will pick different nouns. Some will compose `idb.whenLoaded` and call it `whenReady`; others will compose `Promise.all([idb.whenLoaded, sync.whenConnected])`. Consumers don't know which nouns to expect.

**Reentrance safety is not uniform:**

| Primitive | Double-attach behavior |
| --- | --- |
| `attachTable` | Silent data loss — two wrappers over same Y.Array |
| `attachKv` | Silent data loss — two wrappers over same KV store |
| `attachPlainText` / `attachRichText` | Same — duplicate wrappers |
| `attachAwareness` | Creates a second Awareness instance (both write to same fields, LWW-ish — not fatal but wrong) |
| `attachIndexedDb` | OK — second call creates a second IndexeddbPersistence; both read/write via Y.Doc which is fine |
| `attachSync` | OK — two supervisor loops compete but convergence is fine |
| `attachBroadcastChannel` | OK — idempotent no-op |
| `attachEncryption` | Unsafe — duplicate key-application handlers |

The content-data-layer primitives (Table, Kv, PlainText, RichText) are the dangerous ones. They hand out wrappers around the same Y.Doc slot, and the wrapper caches internal state (last-write-wins timestamps, parse caches).

**Signature shape is not uniform:**

| Primitive | Shape |
| --- | --- |
| `attachTable(ydoc, name, def)` | Positional trio |
| `attachKv(ydoc, defs)` | Two args |
| `attachAwareness(ydoc, defs)` | Two args |
| `attachSync(ydoc, config)` | Config object |
| `attachIndexedDb(ydoc)` | One arg |
| `attachEncryption(ydoc, { stores })` | Destructured config |

Mixed conventions are mostly fine. The specific one that bites is `attachEncryption` — `{ stores: [...] }` reads awkwardly when the caller's natural unit of thought is "the tables and the kv I just attached."

### Key finding

Most inconsistencies are cosmetic. Two are not:

1. **Reentrance unsafety on content-data primitives** is a real bug waiting to happen.
2. **Manual store aggregation in `attachEncryption`** is a real security-relevant footgun (forgetting a store = plaintext writes).

Both are masked today by `defineWorkspace` composing everything correctly behind the curtain. Removing the wrapper exposes both.

### Implication

Removing `defineWorkspace` is net-positive for composability and symmetry, but **requires** fixing #1 and #2 first. Fixing them is independently worthwhile regardless of whether we delete the wrapper — they're latent footguns.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Delete `defineWorkspace` | Yes, after fixes land | Wrapper is 2/3 convention and 1/3 substance. Symmetry with content docs + one-file workspaces wins. |
| `attachEncryption` signature | Change to `attachEncryption(ydoc, { tables, kv })` | Callers pass the attachment objects they already have. Function introspects `.stores` / `.store`. No manual array concat. |
| Unify lifecycle naming | All primitives use `whenReady` + `whenDisposed` | `whenLoaded` / `whenConnected` become aliases or renames. One noun to compose. |
| Reentrance guards | Cache per (`ydoc`, key) on content-data primitives | Table/Kv/PlainText/RichText return the same wrapper on second call with same args. Throws or warns on conflicting definitions. |
| `@epicenter/skills` package shape | Export table definitions + a `defineDocument` factory from `@epicenter/skills` | Shared-schema packages stay package-owned but expose a `defineDocument` factory, not a `defineWorkspace` factory. Consumers still get cache convergence via shared factory. |
| `id` field on workspace | User returns it explicitly | Framework no longer injects `id`; if the caller wants it on the bundle, they put it there. |
| `batch` helper | User returns it explicitly | Sugar over `ydoc.transact`. Either include it in the return or call `ydoc.transact` directly. Not framework-provided. |
| Node / test variants | Package exports a `build()` function callers wrap in `defineDocument` OR pass a `persistence: 'indexeddb' \| 'none'` option | Defer — see Open Questions |
| Config shape normalization | Deferred | Cosmetic. Inconsistencies are real but low-pain. Fix opportunistically. |

## Architecture

### Before

```
┌─────────────────────────────────────────────┐
│  defineWorkspace({ id, tables, kv, aw })    │
│    │                                        │
│    └─ returns WorkspaceFactory              │
│         ├─ .open(id) → Handle<WS>           │
│         └─ .definition: WorkspaceDefinition │
└──────────────┬──────────────────────────────┘
               │
               ▼
  ┌────────────────────────────────┐
  │  inside the factory's builder: │
  │    new Y.Doc({ guid: id })     │
  │    attachTables(…)             │
  │    attachKv(…)                 │
  │    attachAwareness(…)          │
  │    attachEncryption(…)         │
  │    return bundle               │
  └────────────┬───────────────────┘
               │
               ▼
  ┌────────────────────────────────┐
  │  in client.ts:                 │
  │    base = factory.open(id)     │
  │    idb = attachIndexedDb(…)    │
  │    sync = attachSync(…)        │
  │    Object.assign(base, { … })  │
  └────────────────────────────────┘
```

### After

```
┌────────────────────────────────────────────────────────┐
│  defineDocument((id) => {                              │
│    const ydoc = new Y.Doc({ guid: id, gc: false });    │
│    const tables = attachTables(ydoc, tableDefs);       │
│    const kv = attachKv(ydoc, kvDefs);                  │
│    const aw = attachAwareness(ydoc, awDefs);           │
│    const enc = attachEncryption(ydoc, { tables, kv }); │
│    const idb = attachIndexedDb(ydoc);                  │
│    const sync = attachSync(ydoc, { … });               │
│    return { id, ydoc, tables: tables.helpers, …,       │
│             whenReady: idb.whenReady,                  │
│             whenDisposed: Promise.all([…]),            │
│             [Symbol.dispose]() { ydoc.destroy(); }};   │
│  }, { gcTime: Infinity })                              │
└──────────────┬─────────────────────────────────────────┘
               │
               ▼
         factory.open(id) → handle
         (same refcount cache as content docs)
```

One primitive. Same shape for workspaces and content docs.

### Lifecycle promise naming unification

Before (three nouns):

```
  idb:   whenLoaded ───────┐
  sync:  whenConnected ────┼──→ user composes → whenReady (by convention)
  fs:    whenLoaded  ──────┘
```

After (one noun):

```
  idb:   whenReady ────────┐
  sync:  whenReady ────────┼──→ Promise.all(…).then(() => {}) → whenReady (typed, expected)
  fs:    whenReady ────────┘
```

## Implementation Plan

### Phase 1: Fix `attachEncryption` signature

- [x] **1.1** Change `attachEncryption(ydoc, { stores: EncryptedStore[] })` → `attachEncryption(ydoc, { tables?: TablesAttachment, kv?: KvAttachment })`. Backward-compat by keeping `stores` as an escape hatch for now.
- [x] **1.2** Introspect `.stores` off `tables` and `.store` off `kv`. Aggregate internally.
- [x] **1.3** Update `packages/workspace/src/workspace/define-workspace.ts` (the body that will soon be deleted) to use the new form as a smoke test.
- [x] **1.4** Update tests in `packages/workspace/src/workspace/` and any extension tests that call `attachEncryption` directly.
  > **Note**: Used structural types (`TablesLike` / `KvLike`) inside `attach-encryption.ts` rather than importing `TablesAttachment` / `KvAttachment` from `../workspace/`. Avoids a `shared/` → `workspace/` layer inversion. Real types are assignable to the structural shapes.
  > Test additions: two new aggregation tests (`{ tables }` and `{ tables, kv }`) that exercise the introspection path using real `attachTables` / `attachKv`. Existing tests keep the `{ stores }` escape hatch since they construct stores directly.

### Phase 2: Unify lifecycle promise names — **SKIPPED**

> **Decision (2026-04-21)**: Skipping Phase 2 entirely. The distinct names (`whenLoaded`, `whenConnected`) carry semantic meaning that `whenReady` loses:
> - `idb.whenLoaded` — local replay done, safe to render UI
> - `sync.whenConnected` — websocket handshake done, collaborative writes visible
>
> Offline-first composition is `whenReady = idb.whenLoaded` — specifically not waiting on sync. Collapsing to a single noun makes `Promise.all([idb.whenReady, sync.whenReady])` read natural but actually compose "block initial paint on network," which is the opposite of offline-first.
>
> The bundle-level `whenReady` (an app-specific aggregation) is a convention apps can still adopt. But the primitives keep their semantic names. Skipped tasks:
>
> - [ ] ~~**2.1** Rename `attachIndexedDb` return~~
> - [ ] ~~**2.2** Rename `attachFilesystemPersistence` return~~
> - [ ] ~~**2.3** Rename `attachSync` return~~
> - [ ] ~~**2.4** Update docs and examples~~

### Phase 3: Reentrance guards on content-data primitives

- [ ] **3.1** `attachTable(ydoc, name, def)` — cache wrapper on Y.Doc via a `WeakMap<Y.Doc, Map<string, Table>>`. Second call with same `name` returns cached. Second call with different `def` throws.
- [ ] **3.2** Same pattern for `attachKv` (singleton per Y.Doc), `attachPlainText` (cache by key), `attachRichText` (cache by key).
- [ ] **3.3** `attachAwareness` — cache on Y.Doc; second call merges definitions or rejects conflicts.
- [ ] **3.4** Tests: each primitive gets a "second attach returns same instance, mutates visible through both" test.

### Phase 4: Rewrite app client files as direct closures

Fuji already has a working prototype (this branch). Apply the same pattern to:

- [ ] **4.1** `apps/honeycrisp/src/lib/client.ts`
- [ ] **4.2** `apps/zhongwen/src/lib/client.ts`
- [ ] **4.3** `apps/whispering/src/lib/client.ts` — keep the Tauri `isTauri()` branch inside the closure
- [ ] **4.4** `apps/tab-manager/src/lib/client.ts` — keep `dispatchAction(actions, …)` rpc wiring
- [ ] **4.5** `apps/opensidian/src/lib/client.ts` — includes the sqlite-index attach
- [ ] **4.6** `apps/breddit/src/lib/workspace/ingest/reddit/workspace.ts`
- [ ] **4.7** Delete the now-empty `workspace.ts` files (schema moves into `client.ts` or stays as a type-only module)

### Phase 5: Migrate shared-schema packages

- [ ] **5.1** `@epicenter/skills` — replace `defineWorkspace` export with a `defineDocument` factory. Package exports `skillsDocument` (factory), `skillsTable`, `referencesTable` (definitions for callers who want to compose differently).
- [ ] **5.2** Update `@epicenter/skills/node` to wrap the same factory with disk I/O actions.
- [ ] **5.3** Update `apps/skills` and `apps/opensidian` skills sub-workspace to use the new factory.

### Phase 6: Delete `defineWorkspace` and adjust types

- [ ] **6.1** Delete `packages/workspace/src/workspace/define-workspace.ts`.
- [ ] **6.2** Delete `WorkspaceBundle` / `WorkspaceFactory` / `WorkspaceHandle` types — replace call-site usages with local types derived from the closure return.
- [ ] **6.3** Prune the `AnyWorkspaceClient` duck-type check in `packages/cli/src/load-config.ts` — new shape detection is `'ydoc' in x && 'tables' in x`.
- [ ] **6.4** Update `packages/workspace/src/index.ts` exports.

### Phase 7: CLI + playgrounds migration

Out of scope of this spec but downstream — see `specs/20260420T234500-consumer-migration-to-defineworkspace.md` for the broader deletion of `createWorkspace` and the extension system. This spec doesn't require that work to be done first; it simply stops creating new consumers of the old shape.

## Edge Cases

### Shared-schema packages with multiple consumers

**Scenario**: `@epicenter/skills` is imported by `apps/skills`, `apps/opensidian`, and the CLI. All three need to open the same workspace ID and see the same Y.Doc cache.

**Today**: `createSkillsWorkspace()` returns a fresh factory per call, which means three callers get three factories — but they all share the underlying `defineDocument` cache because the cache key is the guid.

**After**: Same. The package exports the factory once; callers share the cache through it.

### Node / CLI / test environments without IndexedDB

**Scenario**: Skills package runs in Node too (CLI, disk I/O). `attachIndexedDb` doesn't work there.

**Options**:
(a) Package accepts a `persistence: 'indexeddb' | 'filesystem' | 'none'` config on the factory
(b) Package exports `build(id)` without persistence; callers wrap in `defineDocument` and add persistence themselves
(c) Browser vs Node entry points (`@epicenter/skills` vs `@epicenter/skills/node`) each export a different factory

Current `@epicenter/skills/node` already does (c). Keep it.

### Workspaces composed differently across apps

**Scenario**: One app wants BroadcastChannel cross-tab sync, another doesn't. One wants offline-first, another wants sync-only. In wrapper-world apps had to accept the wrapper's assumptions. In closure-world each app's closure can differ.

**Resolution**: This is the point. No edge case — it's the feature.

### Forgetting `[Symbol.dispose]()` or `ydoc.destroy()` in the return

**Scenario**: User composes a closure but forgets to call `ydoc.destroy()` in their `[Symbol.dispose]`. Providers don't unwind. IDB handle stays open. `defineDocument`'s cache thinks the bundle is torn down but the ydoc keeps running.

**Resolution**: Document the contract explicitly in `defineDocument`'s JSDoc (it partially does today). Consider a dev-mode lint: `defineDocument`'s builder emits a warning if `bundle[Symbol.dispose]` doesn't invoke `ydoc.destroy()`. Probably overkill — callers see this pattern copy-pasted across the codebase.

### `attachAwareness` on content docs vs workspaces

**Scenario**: A content doc's closure might call `attachAwareness(ydoc, {})` because it's cheap. Then someone composes an outer workspace with awareness too. Two callers write to the same Y.Awareness.

**Resolution**: Phase 3's reentrance guard. Caching on Y.Doc means only one Awareness per Y.Doc; field definitions from second call merge into first.

## Open Questions

1. **Is deprecation-alias-then-rename worth it, or clean break on lifecycle names?**
   - Options: (a) Add `whenReady` while keeping `whenLoaded` / `whenConnected` as aliases for one release; (b) Straight rename, update all call sites in one PR.
   - **Recommendation**: Straight rename. The monorepo has ~10 call sites total; a repo-wide rename is ~15 lines changed. Alias adds surface area for no real migration value.

2. **`attachEncryption({ tables, kv })` — what about future store types?**
   - If we add external indexes or other encrypted stores, the config grows: `{ tables, kv, externalIndexes }`. Every caller touches it.
   - Alternative: `attachEncryption(ydoc, ...attachments)` — variadic, each attachment has a `.stores` array and `attachEncryption` flattens.
   - **Recommendation**: Start with `{ tables, kv }`. Variadic is cleaner long-term but adds one indirection. Revisit when we add a third store type.

3. **Should `defineDocument` provide a conventional bundle-shape helper?**
   - E.g., `composeBundle(ydoc, attachments)` that auto-aggregates `whenReady`, `whenDisposed`, and the `[Symbol.dispose]` cascade.
   - Risk: re-introduces the "conventional shape" we just removed.
   - **Recommendation**: No helper. The 3-line `Promise.all([...]).then(() => {})` pattern is fine. Copy-paste beats abstraction here.

4. **What replaces `WorkspaceClient` in `describe-workspace` and AI-tool generators?**
   - `actionsToAiTools(workspace.actions)` works today because `workspace.actions` is a typed map. No change needed.
   - `describeWorkspace(client)` inspects `.definitions` — that field goes away. Either delete `describeWorkspace` or rebuild it to inspect the bundle structurally.
   - **Recommendation**: Delete. `describeWorkspace` is primarily used in `apps/opensidian/src/routes/about/+page.svelte` as documentation strings; it was never load-bearing.

5. **Do we inline `workspace.ts` into `client.ts`, or keep it as a types-only module?**
   - Inline: one file per app. Everything about the workspace lives in one place.
   - Keep split: `workspace.ts` exports `tableDefs` + `actions`; `client.ts` composes. This survives if you want to share table defs across environments.
   - **Recommendation**: App-dependent. For single-consumer apps (fuji, honeycrisp, whispering) inline. For shared-schema packages (skills, future: filesystem) keep split so defs are importable.

## Success Criteria

- [ ] `packages/workspace/src/workspace/define-workspace.ts` deleted.
- [ ] Every app's `client.ts` is a single `defineDocument` closure that returns the final workspace shape.
- [ ] `attachEncryption` takes `{ tables, kv }` rather than a manual `stores: [...]` array.
- [ ] All persistence/sync primitives expose `whenReady` and `whenDisposed` under those exact names.
- [ ] Content-data primitives (`attachTable`, `attachKv`, `attachPlainText`, `attachRichText`, `attachAwareness`) return cached wrappers on repeat calls with same config, and throw on conflicting config.
- [ ] New reentrance tests cover the silent-data-loss scenarios.
- [ ] All existing app-level tests pass without modification except for naming changes.
- [ ] No call site in `apps/**` or `packages/skills/src/**` references `defineWorkspace`, `WorkspaceBundle`, or `WorkspaceFactory`.

## References

- `packages/workspace/src/workspace/define-workspace.ts` — 33-line body that gets deleted.
- `packages/workspace/src/shared/attach-encryption.ts:75` — `attachEncryption` signature to change.
- `packages/document/src/attach-indexed-db.ts` — `whenLoaded` → `whenReady`.
- `packages/document/src/attach-sync.ts` — `whenConnected` → `whenReady`.
- `packages/document/src/attach-table.ts` — add reentrance guard.
- `packages/document/src/attach-kv.ts` — add reentrance guard.
- `packages/document/src/attach-plain-text.ts` — add reentrance guard.
- `packages/document/src/attach-rich-text.ts` — add reentrance guard.
- `packages/document/src/attach-awareness.ts` — add reentrance guard.
- `packages/filesystem/src/file-content-docs.ts:36–62` — reference pattern for the closure shape.
- `apps/fuji/src/lib/client.ts` — working prototype of the target shape (this branch).
- `apps/fuji/src/lib/entry-content-docs.ts:22` — content-doc pattern that workspaces now mirror.
- `specs/20260420T230100-collapse-document-framework.md` — prior rejection of `.withDocument` sugar for the same reason.
- `specs/20260420T230200-workspace-as-definedocument.md` — made workspace IS a `defineDocument`. This spec removes the remaining wrapper layer.
- `specs/20260420T234500-consumer-migration-to-defineworkspace.md` — the broader migration this builds on.
