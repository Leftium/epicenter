# Document Primitive (`@epicenter/document`)

## When to Read This

Read when composing standalone Y.Docs (per-row content, settings, skills, anything outside `createWorkspace`), or when wiring persistence + sync against a raw `Y.Doc`.

`.withDocument()` on tables was removed. Per-row content docs are now plain `Y.Doc`s opened by the component that owns the lifecycle.

## The Primitive: Just Y.Doc + attach\*

There is no wrapper. You construct a `Y.Doc` yourself and call `attach*` functions on it. `ydoc.destroy()` is the teardown.

```typescript
import { attachIndexedDb, attachRichText, attachSync } from '@epicenter/document';
import * as Y from 'yjs';

export function openMyDoc(id: string) {
  // gc: false because the doc syncs. GC'd deletion markers break peers that
  // haven't seen the deletes. Only set true for purely local, ephemeral docs.
  const ydoc = new Y.Doc({ guid: id, gc: false });

  const content = attachRichText(ydoc);
  const idb = attachIndexedDb(ydoc);
  const sync = attachSync(ydoc, { url, getToken, waitFor: idb.whenLoaded });

  return {
    ydoc,
    content,
    whenLoaded: idb.whenLoaded,
    whenConnected: sync.whenConnected,
    dispose: () => ydoc.destroy(),
  };
}
```

Everything you need is in Yjs itself:

- `new Y.Doc({ guid, gc })` — allocate.
- `ydoc.destroy()` — teardown (fires `'destroy'`; every `attach*` self-registers cleanup via `ydoc.on('destroy', ...)`).
- `ydoc.on('update', fn)` — side effects (e.g. bumping a parent row's `updatedAt`). No framework `onUpdate` convention.

No `defineDocument` / `openDocument` wrapper. No options bag re-exposing Y.Doc config. If Yjs adds new `Y.Doc` options tomorrow, callers get them for free.

## Attach Helpers

Each helper takes a `Y.Doc` and registers cleanup on `ydoc.on('destroy')`. Each returns only what it actually knows.

| Helper | Returns |
|---|---|
| `attachIndexedDb(ydoc)` | `{ whenLoaded, clearLocal, disposed }` |
| `attachSync(ydoc, { url, getToken?, waitFor?, awareness? })` | `{ whenConnected, status, onStatusChange, reconnect, disposed }` |
| `attachRichText(ydoc)` | `RichTextAttachment` — `{ read, write, binding: Y.XmlFragment }` |
| `attachPlainText(ydoc)` | `PlainTextAttachment` — `{ read, write, binding: Y.Text }` |
| `attachTable(ydoc, def)` | Typed row helper over `Y.Map` |
| `attachKv(ydoc, defs)` | Typed KV helper |
| `attachAwareness(ydoc, defs)` | Typed awareness helper |

`attachSync`'s `waitFor` gates the first connection attempt on another promise — typically `idb.whenLoaded` — so the first handshake exchanges only a delta, not the full document.

## Readiness Signals: Split, Don't Precompose

Each helper returns what it actually knows. Callers compose at the call site.

- `idb.whenLoaded` — "local draft is in memory, edits are safe" (offline-first UI usually only needs this).
- `sync.whenConnected` — "transport established, first sync exchange finished" (CLIs that need remote state await this).

There is no `whenSynced` composite. If you need both, `Promise.all([idb.whenLoaded, sync.whenConnected])` at the call site. This is intentional — `y-indexeddb`'s upstream `whenSynced` is a misnomer (it's local load, not convergence).

## Canonical Per-Row Content Doc

Replaces the old `.withDocument('content', { content: richText, guid: 'id', onUpdate })` on a table:

```typescript
// apps/fuji/src/lib/entry-content-doc.ts
import { attachIndexedDb, attachRichText, attachSync, toWsUrl } from '@epicenter/document';
import * as Y from 'yjs';
import { workspace, auth } from './client';

export function openEntryContentDoc(rowId: EntryId) {
  const ydoc = new Y.Doc({
    guid: `epicenter.fuji.entries.${rowId}.content`,
    gc: false,
  });

  const content = attachRichText(ydoc);
  const idb = attachIndexedDb(ydoc);
  const sync = attachSync(ydoc, {
    url: (docId) => toWsUrl(`${APP_URLS.API}/docs/${docId}`),
    getToken: async () => auth.token,
    waitFor: idb.whenLoaded,
  });

  // Plain closure — no framework-mediated onUpdate. Bumps parent row.
  ydoc.on('update', () => {
    workspace.tables.entries.update(rowId, { updatedAt: DateTimeString.now() });
  });
  // No explicit off() — ydoc.destroy() clears its own listeners.

  return {
    ydoc,
    content,
    whenLoaded:    idb.whenLoaded,
    whenConnected: sync.whenConnected,
    whenDisposed:  Promise.all([idb.whenDisposed, sync.whenDisposed]).then(() => {}),
    clearLocal:    idb.clearLocal,
    reconnect:     sync.reconnect,
    dispose:       () => ydoc.destroy(),
  };
}
```

Component owns the lifecycle:

```svelte
<script lang="ts">
  import { openEntryContentDoc } from '$lib/entry-content-doc';
  let { row } = $props();
  let doc: ReturnType<typeof openEntryContentDoc> | null = $state(null);
  $effect(() => {
    doc = openEntryContentDoc(row.id);
    return () => doc?.dispose();
  });
</script>

{#if doc}
  {#await doc.whenLoaded}
    <Spinner />
  {:then}
    <RichEditor binding={doc.content.binding} />
  {/await}
{/if}
```

Two tabs editing the same entry reconcile at the Yjs layer (IndexedDB + sync). No JS-side deduplication.

## Module-Scope Singleton Pattern

A factory function evaluated at module scope becomes a singleton via ES module caching — no registry needed:

```typescript
// packages/skills/src/doc.ts
export const skills = openSkillsDoc();  // evaluated once per graph
```

Synchronous construction means no top-level-await propagation, trivially mockable in tests.

## Anti-Patterns

```typescript
// ❌ Don't reach for ydoc for content operations
const ytext = handle.content.ydoc.getText('content');

// ✅ Use the attachment's API
handle.content.read();
handle.content.write('hello');
handle.content.binding;  // for editor bindings (Y.XmlFragment / Y.Text)
```

```typescript
// ❌ Don't compose a "whenSynced" that Promise.alls idb + sync
// You're hiding which signal the caller actually depends on.

// ✅ Expose atoms; compose at the call site only when you truly need both
await doc.whenLoaded;                                         // typical UI
await Promise.all([doc.whenLoaded, doc.whenConnected]);       // CLI needing remote state
```

```typescript
// ❌ Don't pass gc: true on a synced doc
new Y.Doc({ guid, gc: true });  // peers lose deletion markers

// ✅ Default to gc: false — only opt in for purely local ephemeral docs
new Y.Doc({ guid, gc: false });
```

## Relationship to `createWorkspace`

`createWorkspace` is the single-Y.Doc sugar: one workspace def, one Y.Doc, one `.withExtension` chain. Under the hood, `createWorkspace` does exactly what you'd write by hand — `new Y.Doc(...)`, then `createTableHelper`, `createKvHelper`, `createAwarenessHelper` (the workspace-flavored equivalents of `attachTable`/`attachKv`/`attachAwareness`). If your app fits in one Y.Doc, keep using `createWorkspace` — it hasn't changed. Reach for raw `Y.Doc` + `attach*` when you need a second scope: per-row content, split settings, skills, or any non-workspace Yjs doc.

## Code References

- `packages/document/src/attach-indexed-db.ts` — persistence attach
- `packages/document/src/attach-sync.ts` — sync attach (supervisor, backoff, awareness)
- `packages/document/src/attach-rich-text.ts`, `attach-plain-text.ts`
- `apps/fuji/src/lib/entry-content-doc.ts` — canonical per-row example
- `packages/workspace/src/workspace/create-workspace.ts` — `createWorkspace` built on raw Y.Doc + helpers
