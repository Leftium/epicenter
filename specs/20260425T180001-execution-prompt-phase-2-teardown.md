# Execution prompt — Phase 2: big teardown of factory / handle / Document / openFuji

**Status**: executed-with-revisions on `drop-document-factory`. Six of the seven deletions landed verbatim. Deletion 3 (delete `openFuji()` wrappers) was reversed by a same-day architectural decision — see the gravestone in that section. The rest of this prompt is preserved as-written, with completion markers added per deletion. Anything below that contradicts the markers is stale and should be read as historical context.

**For an implementer with no prior conversation context.** Self-contained brief.

**Prerequisites**:
- The big merge PR (assembled from this branch) has landed on main.
- Phase 1 (`specs/20260425T120000-execution-prompt-phase-1.md`) has landed: `attachSync` already takes `dispatch:` and `getToken:`; `ACTION_BRAND` is gone; actions are passthrough (later reverted from always-Result by `20260425T200000-actions-passthrough-adr.md`); `RemoteReturn` is deleted; `requiresToken` is dropped.

**Branch**: this work landed on `drop-document-factory` directly, stacked onto Phase 1, in PR #1705.

**Read these specs first**:
- `specs/20260424T180000-drop-document-factory-attach-everything.md` — the teardown architecture (the *why*; this prompt is the *how*).
- `specs/20260425T000000-device-actions-via-awareness.md` — additive layer that comes *after* this phase. Mentioned only because some symbols this phase removes are referenced by the awareness spec's helpers.

---

## What you're doing

Remove the document-factory infrastructure outright. Replace SPA bootstrap modules and CLI configs with **top-level inline composition** at module scope. Rewrite the CLI loader to consume domain-named exports directly (no `entry.handle` envelope).

This is the largest PR in the spec sequence. ~600-1200 lines of net deletions plus consumer rewrites. Single PR is fine because most of the deletions are coupled (you can't delete `Document` without deleting `DocumentHandle`, and you can't delete `DocumentHandle` without rewriting `loadConfig`).

---

## The seven deletions

### Deletion 1 — `Document` / `DocumentBundle` types — **DONE**

**Landed in**: the same wave that introduced `createDisposableCache` (commit `814965d10`) plus the per-app inline composition rollout (`cfc0e472e`).

**Today**: `packages/workspace/src/document/document.ts` exports `Document` (and possibly `DocumentBundle`) as a structural type — `{ ydoc: Y.Doc; [Symbol.dispose](): void; whenReady?: Promise<unknown>; [key: string]: unknown }`. Every app's `client.svelte.ts` returns an object `satisfies Document`.

**After**: delete the type. SPA `client.svelte.ts` returns a literal object whose type is inferred. Consumers needing to reference the type use `typeof fuji`.

### Deletion 2 — `Document`-flavored ceremony around the cache; rename the cache to what it actually is — **DONE**

**Landed in**: commit `814965d10` (`refactor(workspace): replace createDocumentFactory with createDisposableCache`). The renamed cache lives at `packages/workspace/src/cache/disposable-cache.ts`.

**Today**: `createDocumentFactory(builder, { gcTime })` is three layers fused together:

1. A refcounted disposable cache (`Map<id, { value, refcount, gcTimer }>`).
2. A per-handle dispose facade (prototype-chained shallow copy with `Symbol.dispose` overridden so consumers get `using`-compatible handles).
3. Document-specific ceremony: the `Document` structural type constraint, `DOCUMENT_HANDLE` brand symbol, `isDocumentHandle` predicate, `DocumentHandle<T>` type alias.

Layer 3 exists for one reason: `iterateActions` walks arbitrary bundles and uses the brand to recognize "this is a doc handle, descend into it." This phase deletes `iterateActions` (Deletion 5) and `satisfies Document` (Deletion 1) — so layer 3 has zero remaining consumers the moment the rest of this spec lands.

**After**: delete layer 3, **keep and rename layers 1 + 2**. The mechanism is generic, framework-free, and already correct — it was hiding under a name that promised more than it delivered. Move it to `packages/workspace/src/cache/disposable-cache.ts` and expose it as:

```ts
/**
 * Refcounted cache for disposable resources. Same id → same instance shared
 * across consumers; teardown is debounced after the last consumer leaves.
 *
 * Solves three coupled problems:
 *
 * 1. Concurrent consumers of the same id must share ONE instance — otherwise
 *    local state diverges (two editors on the same Y.Doc would only see each
 *    other's edits after a sync round-trip).
 * 2. Sequential mount/unmount (route swap, HMR, conditional render, split-pane
 *    close-then-reopen) shouldn't rebuild expensive resources. `gcTime` keeps
 *    the instance alive briefly so the next `open` can reuse it.
 * 3. Page exit / workspace teardown needs explicit disposal. The cache itself
 *    is `Disposable`.
 *
 * The value type is opaque: anything `Disposable`. Y.Docs are the most common
 * case in this codebase; audio decoders, worker connections, MediaStreams,
 * and Tauri window handles fit the same shape and should use this primitive.
 */
export interface DisposableCache<Id, T> extends Disposable {
  /** Open a handle. Increments refcount. The handle's `Symbol.dispose`
   *  decrements the refcount — it does NOT destroy the underlying T directly. */
  open(id: Id): T & Disposable;
  /** True if an instance is currently held (refcounted or in grace window). */
  has(id: Id): boolean;
}

export function createDisposableCache<
  Id extends string | number,
  T extends Disposable,
>(
  build: (id: Id) => T,
  opts?: { gcTime?: number }, // default: 5_000ms
): DisposableCache<Id, T>;
```

**Design choices, each load-bearing:**

- **`Id extends string | number`**: `Map` equality on objects is reference equality — a footgun. Strings and numbers cover essentially every real use case. Add a `keyFn` overload only when something genuinely needs compound keys.
- **Synchronous `build`**: construction returns immediately. If `T` needs async readiness (IndexedDB hydration, sync handshake), expose a `whenReady: Promise<unknown>` field on `T`. The cache stays synchronous; readiness is a value-level concern. This matches the existing convention.
- **Per-handle wrapper, not raw `T`**: `open()` returns `T & Disposable` where `Symbol.dispose` decrements *this handle's* refcount — it does not destroy the underlying `T`. The underlying `T[Symbol.dispose]` is called once, by the cache, when the refcount reaches zero after `gcTime`. The prototype-chain trick from the current implementation is the cheap implementation: shadow `Symbol.dispose`, fall through everything else. Per-handle wrapper writes don't leak between consumers.
- **No `close(id)` method**: one way to release — dispose the handle. Two ways means call sites that mismatch open/close.
- **Cache is `Disposable`, no `closeAll()`**: `cache[Symbol.dispose]()` flushes every entry immediately. One concept; works with `using` in tests.
- **`gcTime` default 5_000ms**: long enough to survive component remounts and HMR; short enough that closing a tab feels responsive. Callers can override.

**Why this is the right abstraction (not a Y/doc-specific thing):**

The constraint on `T` is `Disposable` — nothing else. That's the honest contract. Every other property (Y.Doc, ydoc field, whenReady, awareness) belongs to the *caller's* builder. The cache doesn't know or care. Future cases — Whispering audio decoders shared across waveform/transcript views, Tauri webview handles shared across UI surfaces, shared workers per task type, MediaStream sharing across preview components — all fit without changes.

### Deletion 3 — `openFuji()` / `openConfig()` wrapper functions — **SUPERSEDED**

> **🪦 This deletion was reversed.** It executed first (commit `ca3b81a77` — *"drop bundle + open\* — fully flat module-scope exports"*), held for hours, then got reversed by `83feb2d94` (*"restore open\* wrappers; lift caches to siblings"*) followed by the iso/env/client three-file split (`8f46308e9` skill + six per-app refactor commits). The reversal is specced in `specs/20260425T225350-app-workspace-folder-env-split.md` and codified in `.claude/skills/workspace-app-layout/SKILL.md`.
>
> **Why the reversal won**: the spec's axiom — *"a function called exactly once is unused encapsulation; the module IS the workspace"* — is true at v3 (one consumer, one call site). It stops being true the moment a Node tool, a CLI test, codegen, or a build-config tries to construct the workspace without dragging in `y-indexeddb`/`BroadcastChannel`/auth side-effects. At that point the wrapper isn't encapsulation — it's a *seam* between iso construction and env binding. Counting callers is the wrong measure; the right test is "would removing this make a forbidden import possible?"
>
> **Today's shape per app**:
> ```
> apps/<app>/src/lib/<app>/
> ├── index.ts       ← iso doc factory      (open<App>())
> ├── <binding>.ts   ← pure env factory     (open<App>({ auth }))
> └── client.ts      ← singleton + auth + lifecycle
> ```
>
> Original deletion-3 prose preserved below for historical context. **Do not execute it.**

---

**Today**: each app's `client.svelte.ts` has `export function openFuji() { /* ... */ } export const fuji = openFuji();`. The wrapper is unused encapsulation — Fuji is a singleton; the function is called exactly once.

**After**: promote the wrapper's body to top-level statements at module scope. Drop the function entirely. The module IS the workspace. Section comments group the file by phase (identity → state → storage → behavior → publish to awareness → network → factories → wiring → export).

The teardown spec at section "Layer 4 — SPA bootstrap" shows the canonical post-refactor `client.svelte.ts`. Mirror that structure.

### Deletion 4 — Domain-named export — **DONE**

**Landed in**: commits `cfc0e472e` (initial inline composition + rename) and `aec984636` (sweep `workspace` → domain-noun across consumers). Each app exports its singleton from `lib/<app>/client.ts` as `<app>` (e.g. `fuji`, `honeycrisp`, `tabManager`).

**Today**: `apps/fuji/src/lib/client.svelte.ts` exports `export const workspace = openFuji()` (or similar generic name).

**After**: rename to the domain noun: `export const fuji = ...`. Update every importing file (`import { workspace } from '$lib/client.svelte'` → `import { fuji } from '$lib/client.svelte'`). Same for `apps/honeycrisp` (`honeycrisp`), `apps/opensidian`, `apps/tab-manager` (`tabManager`), `apps/whispering`, `apps/zhongwen`.

### Deletion 5 — `iterateActions` walking arbitrary bundles — **DONE**

**Landed in**: commit `3366fe3a9` (CLI side: replaced with `walkActions` in `packages/cli/src/util/walk-actions.ts`) plus a follow-up that inlined the workspace-side generator into `actionsToAiTools`'s sole caller and dropped `iterateActions` from the public API entirely. No dev-namespace residue — there were no remaining consumers worth keeping the export around for.

**Today**: `iterateActions(handle)` walks an entire bundle (ydoc, tables, kv, sync, ...) looking for branded callables. Used by `epicenter list` and `ActionIndex`.

**After**: delete `iterateActions`. The CLI loader receives the workspace export's `actions` field directly (it's a known shape on the export). For listing, walk `actions` with a small recursive helper *or* just `Object.entries` if the registry stays flat. The scope of "what to walk" shrinks from "the whole bundle" to "a known actions sub-tree."

If `iterateActions` is needed for dev tooling (it might still be useful for debugging or documentation generation), keep it but move it out of the framework's public API into a `dev` namespace.

### Deletion 6 — `ActionIndex` and `buildActionIndex` — **DONE**

**Landed in**: commit `3366fe3a9`. CLI dispatch now resolves `actions[path]` directly via `findAction` / `actionsUnder` in `packages/cli/src/util/walk-actions.ts`; no precomputed index.

**Today**: `packages/cli/src/util/action-index.ts` builds a flat `Map<string, Action>` from `iterateActions(handle)` at config load. `LoadConfigResult.entries[].actions: ActionIndex` carries it.

**After**: delete the file. CLI dispatch becomes `dispatchAction(entry.workspace.actions, path, input)` — direct walk of the user's action tree. For sibling-suggestion errors, walk the same tree. No precomputed index.

### Deletion 7 — `entry.handle` envelope in CLI loader — **DONE**

**Landed in**: commit `3366fe3a9`. CLI loader now returns `{ entries: Array<{ name, workspace }>, dispose }`; commands read first-class fields off `entry.workspace` (no more `entry.handle.X`, no `getSync`/`extractAwareness` duck-type helpers).

**Today**: `packages/cli/src/load-config.ts` returns `{ entries: Array<{ name, handle: DocumentHandle, actions: ActionIndex }>, dispose }`. CLI commands do `entry.handle.whenReady`, `getSync(entry.handle)`, `readPeers(entry.handle)`.

**After**: loader returns `{ entries: Array<{ name, workspace: LoadedWorkspace }>, dispose }` where `LoadedWorkspace` has first-class fields:

```ts
type LoadedWorkspace = {
  whenReady: Promise<unknown>;
  actions?: Actions;
  sync?: SyncAttachment;
  awareness?: AwarenessLike;
  [Symbol.dispose](): void;
};
```

The loader pulls these fields directly off the imported export. CLI commands become `await entry.workspace.whenReady`, `entry.workspace.sync.rpc(...)`, `entry.workspace.awareness.getStates()`. `getSync` and `extractAwareness` duck-type helpers in `packages/cli/src/util/handle-attachments.ts` are deleted.

---

## Files to touch

### Delete entirely

- `packages/cli/src/util/action-index.ts`
- `packages/cli/src/util/handle-attachments.ts`

### Replace (rename + slim down, do not delete the file)

- `packages/workspace/src/document/document.ts` → `packages/workspace/src/cache/disposable-cache.ts`. Keep the refcount/gcTime machinery and the per-handle dispose wrapper. Delete the `Document` type, `DocumentBundle`, `DocumentHandle<T>`, `DOCUMENT_HANDLE` brand symbol, `isDocumentHandle` predicate, the `DocEntry` brand wiring. Type signature becomes `createDisposableCache<Id extends string | number, T extends Disposable>(build, opts?)`. Expected size: ~100-150 lines (down from 500+).

### Modify substantially

- `packages/workspace/src/index.ts` — remove deleted exports (`Document`, `DocumentBundle`, `DocumentHandle`, `createDocumentFactory`, `isDocumentHandle`, `iterateActions` if removed, `DOCUMENT_HANDLE`, `DocumentFactory`). Add `createDisposableCache`, `DisposableCache`.
- `packages/svelte-utils/src/from-document.svelte.ts` → `from-disposable-cache.svelte.ts`. Rename function to `fromDisposableCache`. Re-type per the call-site section above. Update `packages/svelte-utils/src/index.ts` re-export.
- `apps/fuji/src/lib/entry-content-docs.ts` — **delete** the `createEntryContentDocs(deps)` factory wrapper. Export `createEntryContentDoc({ entryId, workspaceId, entriesTable, auth, apiUrl })` as a pure single-doc builder per the call-site section. Builder body logic unchanged; only the wrapping shape changes.
- `apps/honeycrisp/src/lib/note-body-docs.ts` — same teardown: delete `createNoteBodyDocs(deps)` factory; export `createNoteBodyDoc({ noteId, ... })` as a pure builder.
- `apps/fuji/src/lib/client.svelte.ts` and `apps/honeycrisp/src/lib/client.svelte.ts` — wire `createDisposableCache(id => createXDoc({ id, ...deps }), { gcTime })` inline at module scope. Don't import the old plural factory.
- Any other app that introduces per-row docs in this PR follows the same shape: one file per resource type exporting `createXDoc({ id, ...deps })`, cache wired inline at workspace module scope.
- All Svelte components importing `fromDocument` — rename to `fromDisposableCache`.
- `packages/workspace/src/shared/actions.ts` — drop `iterateActions` if relocating to dev-namespace; otherwise leave alone.
- `packages/cli/src/load-config.ts` — full rewrite per Deletion 7 above. New `LoadedWorkspace` type, new entries shape, new dispose flow.
- `packages/cli/src/commands/run.ts` — read `entry.workspace.actions` directly, dispatch via `dispatchAction(entry.workspace.actions, path, input)`. Drop all `entry.handle.X` and `getSync(entry.handle)` usage.
- `packages/cli/src/commands/peers.ts` — read `entry.workspace.awareness` directly. No more `extractAwareness`.
- `packages/cli/src/commands/list.ts` (if exists) — walk `entry.workspace.actions` directly.
- All app `client.svelte.ts` files (apps/fuji, honeycrisp, opensidian, tab-manager, whispering, zhongwen) — promote `openFuji()` body to module scope; rename export to domain noun; update consumers.

### Modify lightly

- For each app, every file that imports `import { workspace } from '$lib/client.svelte'` updates to the domain-named export.
- `packages/workspace/README.md` — lead with the inline-composition pattern; remove `Document` / `createDocumentFactory` documentation.
- `.agents/skills/workspace-api/SKILL.md` — same: drop factory/handle terminology; reframe around `attach*` primitives + inline composition.
- `docs/articles/workspaces-were-documents-all-along.md` (currently held) — add the v4 coda explaining the factory removal. Stage and commit.

### Verify (grep)

After all edits, expect zero hits in `**/*.{ts,tsx,svelte,js,mjs}` for:
- `Document` (the type)
- `DocumentBundle`
- `DocumentHandle`
- `DocumentFactory`
- `createDocumentFactory`
- `defineDocument`
- `DOCUMENT_HANDLE` symbol
- `isDocumentHandle`
- `iterateActions`
- `ActionIndex` / `buildActionIndex`
- `entry.handle` (in `packages/cli/`)
- `getSync(` / `extractAwareness(` (in `packages/cli/`)
- `satisfies Document`
- `fromDocument` (renamed to `fromDisposableCache`)
- `createEntryContentDocs` (plural — replaced by singular `createEntryContentDoc`)
- `createNoteBodyDocs` (plural — replaced by singular `createNoteBodyDoc`)

And expect new hits for:
- `createDisposableCache` (in `packages/workspace`, plus the per-row caches in fuji + honeycrisp)
- `DisposableCache` (type import in `packages/svelte-utils`)
- `fromDisposableCache` (in `packages/svelte-utils`, app components)
- `createEntryContentDoc` (singular, in `apps/fuji`)
- `createNoteBodyDoc` (singular, in `apps/honeycrisp`)

> **Note on `openFuji` / `export const workspace`**: per the Deletion 3 gravestone, both shapes are deliberately *present* under the iso/env/client convention. `open<App>()` factories live in each app's `lib/<app>/{index,<binding>}.ts`; the singleton `export const <app>` lives in `lib/<app>/client.ts`. Don't grep these as removal targets.

---

## Call site migrations

### Per-row content docs (Fuji + Honeycrisp)

`apps/fuji/src/lib/entry-content-docs.ts` and `apps/honeycrisp/src/lib/note-body-docs.ts` use `createDocumentFactory` for per-row Y.Docs. This is the canonical `DisposableCache` use case — multiple components (split-pane editors, preview tiles) mount the same entry's content concurrently, and the user clicks between entries fast enough that immediate disposal would thrash IndexedDB.

The migration is **two coupled changes**, not one. First the cache primitive swap (`createDocumentFactory` → `createDisposableCache`). Second, kill the **factory-of-a-factory** pattern: `createEntryContentDocs(deps)` is itself the same anti-pattern as `openFuji()` at a smaller scope — a function called exactly once with statically-known deps, whose only purpose is to defer construction until those deps exist. After this PR, the file exports a **pure single-doc builder**; the cache is constructed inline at module scope alongside the rest of the workspace setup.

**Before** (`apps/fuji/src/lib/entry-content-docs.ts`):

```ts
import { createDocumentFactory, /* ... */ } from '@epicenter/workspace';

// Factory of a factory: takes deps, returns a factory whose .open(id)
// returns a doc handle. Called once from client.svelte.ts.
export function createEntryContentDocs({ workspaceId, entriesTable, auth }) {
  return createDocumentFactory((entryId: EntryId) => {
    const ydoc = new Y.Doc({ guid: docGuid({ /* ... */ }), gc: false });
    const body = attachRichText(ydoc);
    const idb = attachIndexedDb(ydoc);
    attachSync(ydoc, { /* ... */ });
    onLocalUpdate(ydoc, () => entriesTable.update(entryId, { /* ... */ }));
    return {
      ydoc, body,
      whenReady: idb.whenLoaded,
      [Symbol.dispose]() { ydoc.destroy(); },
    };
  });
}
```

**After** (`apps/fuji/src/lib/entry-content-docs.ts`):

```ts
import type { AuthCore } from '@epicenter/auth-svelte';
import {
  attachIndexedDb, attachRichText, attachSync,
  DateTimeString, docGuid, onLocalUpdate, toWsUrl,
  type Table,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import type { Entry, EntryId } from '$lib/workspace';

export type EntryContentDoc = {
  ydoc: Y.Doc;
  body: ReturnType<typeof attachRichText>;
  whenReady: Promise<void>;
  [Symbol.dispose](): void;
};

/**
 * Construct the per-entry content document. Pure: same inputs always produce
 * the same shape. All deps are explicit; nothing closed over from module scope
 * (no `APP_URLS`, no implicit auth singleton).
 */
export function createEntryContentDoc({
  entryId,
  workspaceId,
  entriesTable,
  auth,
  apiUrl,
}: {
  entryId: EntryId;
  workspaceId: string;
  entriesTable: Table<Entry>;
  auth: Pick<AuthCore, 'getToken'>;
  apiUrl: string;
}): EntryContentDoc {
  const ydoc = new Y.Doc({
    guid: docGuid({
      workspaceId, collection: 'entries', rowId: entryId, field: 'content',
    }),
    gc: false,
  });
  const body = attachRichText(ydoc);
  const idb = attachIndexedDb(ydoc);
  attachSync(ydoc, {
    url: toWsUrl(`${apiUrl}/docs/${ydoc.guid}`),
    waitFor: idb.whenLoaded,
    getToken: () => auth.getToken(),
  });
  onLocalUpdate(ydoc, () => {
    entriesTable.update(entryId, { updatedAt: DateTimeString.now() });
  });
  return {
    ydoc, body,
    whenReady: idb.whenLoaded,
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}
```

**Wiring at module scope** (`apps/fuji/src/lib/client.svelte.ts`):

```ts
import { createDisposableCache } from '@epicenter/workspace';
import { createEntryContentDoc } from '$lib/entry-content-docs';

// ... ydoc, encryption, tables, auth, sync already constructed above ...

const entryContentDocs = createDisposableCache(
  (entryId) => createEntryContentDoc({
    entryId,
    workspaceId: ydoc.guid,
    entriesTable: tables.entries,
    auth,
    apiUrl: APP_URLS.API,
  }),
  { gcTime: 5_000 },
);
```

`apps/honeycrisp/src/lib/note-body-docs.ts` migrates identically: export `createNoteBodyDoc({ noteId, ... })`, wire `createDisposableCache` inline in Honeycrisp's `client.svelte.ts`.

### API shape rationale

Two design choices in `createEntryContentDoc` that are load-bearing across all per-row builders in the codebase:

**1. Single destructured options object, not `(id, deps)`.**
The two-argument form (`createEntryContentDoc(entryId, { workspaceId, ... })`) encodes a real semantic — id varies per cache key, the rest is stable workspace config — but at the cost of a parameter shape that doesn't match anything else in the codebase. Every other `create*` in the repo takes one options bag. Object shorthand keeps the cache wiring concise (`(entryId) => createEntryContentDoc({ entryId, ... })`), and tests get one named-fields object instead of remembering positional order. The "id is special" signal lives at the cache wiring site, where it belongs.

**2. `create*` prefix, singular noun.**
The codebase has three established verbs: `attach*` (mutates ydoc), `define*` (static schema), `create*` (constructs an instance). `createEntryContentDoc` fits the third bucket. The **singular form** (vs. the deleted plural `createEntryContentDocs`) is the signal that the factory layer is gone — one call, one doc. No new `build*` prefix; the codebase doesn't currently distinguish "service with methods" from "value", and introducing that distinction for one function isn't worth the convention churn.

**3. All deps explicit; nothing imported into the builder file beyond pure framework primitives.**
`apiUrl: string` is passed in instead of importing `APP_URLS` directly. Same for `auth`. This makes the builder genuinely portable — testable with mock deps, reusable in non-Vite contexts (SSR, Tauri-only build, future workers). The cost is one more field in the options object; the win is zero hidden dependencies.

### Svelte adapter (`packages/svelte-utils/src/from-document.svelte.ts`)

The adapter that bridges the cache to Svelte's `$derived` + `$effect` lifecycle exists today as `fromDocument`. Rename and re-type:

**Before**:

```ts
import type { DocumentFactory, DocumentHandle } from '@epicenter/workspace';

export function fromDocument<Id extends string, T>(
  factory: DocumentFactory<Id, T>,
  idFn: () => Id,
): { readonly current: DocumentHandle<T> } {
  const handle = $derived(factory.open(idFn()));
  $effect(() => {
    const h = handle;
    return () => h.dispose();
  });
  return { get current() { return handle; } };
}
```

**After**:

```ts
import type { DisposableCache } from '@epicenter/workspace';

export function fromDisposableCache<
  Id extends string | number,
  T extends Disposable,
>(
  cache: DisposableCache<Id, T>,
  idFn: () => Id,
): { readonly current: T & Disposable } {
  const handle = $derived(cache.open(idFn()));
  $effect(() => {
    const h = handle;
    return () => h[Symbol.dispose]();
  });
  return { get current() { return handle; } };
}
```

Two real changes: the type imports and `h.dispose()` → `h[Symbol.dispose]()`. The body is otherwise identical because the runtime behavior is identical.

Re-export `fromDisposableCache` from `@epicenter/svelte`. Keep `fromDocument` as a deprecated alias only if a follow-up PR will remove it; per spec policy ("no backwards-compat shims"), prefer renaming all call sites in this PR.

### Component consumer (no change)

```svelte
<script lang="ts">
  import { fromDisposableCache } from '@epicenter/svelte';
  import { entryContentDocs } from '$lib/client.svelte';

  let { entry }: { entry: Entry } = $props();
  const contentDoc = fromDisposableCache(entryContentDocs, () => entry.id);
</script>

{#await contentDoc.current.whenReady}
  <Skeleton />
{:then}
  <CodeMirrorEditor ytext={contentDoc.current.body.binding} />
{/await}
```

The only call-site delta is the import name. Component code is otherwise untouched.

### Module-level singleton workspaces (separate concern)

The other use of `createDocumentFactory` is at the workspace singleton level — `openFuji()`, `openConfig()`, etc. **Those do NOT migrate to `createDisposableCache`.** Singletons don't need refcounting; there is exactly one consumer (the module itself). Per Deletion 3, the wrapper function is dropped entirely and the body becomes top-level statements at module scope. `createDisposableCache` is for *per-row* docs only.

This is the cleanest signal that splitting layer 3 from layers 1+2 was right: the two original use cases (singleton workspace construction vs per-row resource sharing) wanted different things, and the old `createDocumentFactory` made both pay for the union.

---

## Test surface

- `bun test` passes everywhere.
- `bun run build` passes everywhere.
- All six apps boot, hydrate, and write end-to-end.
- Two-tab editing on Fuji + Honeycrisp shows CRDT propagation (no regression from refcount-cache extraction).
- CLI commands work: `epicenter list`, `epicenter run fuji.entries.create '{...}'`, `epicenter peers`, `epicenter run --peer <field>=<value>`.
- The article `docs/articles/workspaces-were-documents-all-along.md` reads cleanly with the v4 coda.

---

## Self-check before opening the PR

- [ ] Zero hits in repo for the grep targets above
- [ ] All six apps export domain-named workspaces
- [ ] All app `client.svelte.ts` files have section comments per the canonical structure
- [ ] CLI loader returns `entry.workspace`, not `entry.handle`
- [ ] Per-row content docs (Fuji entries, Honeycrisp notes) work via `createDisposableCache`
- [ ] Two-tab/split-pane editing on the same entry id shares one Y.Doc instance (no divergence)
- [ ] Rapid entry-A → entry-B → entry-A clicks reuse the cached doc (no IndexedDB rehydrate flash)
- [ ] `bun test` passes
- [ ] `bun run build` passes
- [ ] `workspaces-were-documents-all-along.md` includes a v4 coda

If anything fails, stop and report. Don't paper over.

---

## What this enables (so you know when to stop)

After this PR lands, two more PRs unblock:

1. **Awareness publishing layer** (per `specs/20260425T000000-device-actions-via-awareness.md`) — adds `serializeActionManifest`, `invoke`, the awareness state convention, Fuji/playgrounds publishing offers. Helper functions only; no new attach.
2. **CLI cross-device dispatch** — `epicenter devices` command, dot-prefix run resolution (`epicenter run desktop-1.action.path`).

If you finish this PR and feel tempted to start adding awareness publishing or CLI cross-device features — stop. Those are the next PRs. Keep this one focused.

---

## Style and process

- Conventional Commits per `.agents/skills/git/`.
- Use `wellcrafted` for new error types per existing codebase patterns.
- No backwards-compat shims. All consumers migrate in this PR.
- Keep the diff focused — don't opportunistically refactor unrelated code.
- The article coda (v4) ships in this PR's commits.
