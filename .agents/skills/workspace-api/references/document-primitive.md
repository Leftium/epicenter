# Document Primitive (`@epicenter/document`)

## When to Read This

Read when composing standalone Y.Docs (per-row content, settings, skills, anything outside `createWorkspace`), or when wiring persistence + sync against a raw `Y.Doc`.

`.withDocument()` on tables was removed. Per-row content docs are now plain `Y.Doc`s opened by the component that owns the lifecycle.

## The Primitive: Just Y.Doc + attach\*

You construct a `Y.Doc` yourself and call `attach*` functions on it. `ydoc.destroy()` is the teardown. A builder closure returns the bundle:

```typescript
import {
  attachIndexedDb,
  attachRichText,
  attachSync,
  onLocalUpdate,
} from '@epicenter/document';
import * as Y from 'yjs';

function buildMyDoc(id: string) {
  // gc: false because the doc syncs. GC'd deletion markers break peers that
  // haven't seen the deletes. Only set true for purely local, ephemeral docs.
  const ydoc = new Y.Doc({ guid: id, gc: false });

  const content = attachRichText(ydoc);
  const idb = attachIndexedDb(ydoc);
  const sync = attachSync(ydoc, { url, getToken, waitFor: idb.whenLoaded });

  onLocalUpdate(ydoc, () => { /* bump parent row updatedAt, etc. */ });

  return {
    ydoc,
    content,
    idb,
    sync,
    whenReady:    idb.whenLoaded,
    whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed]).then(() => {}),
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}
```

Everything you need is in Yjs itself:

- `new Y.Doc({ guid, gc })` — allocate.
- `ydoc.destroy()` — teardown (fires `'destroy'`; every `attach*` self-registers cleanup via `ydoc.on('destroy', ...)`).
- `onLocalUpdate(ydoc, fn)` — side effects triggered only by **local** transactions (e.g. bumping a parent row's `updatedAt`). Filters out remote sync updates so you don't loop.

The builder is a plain function. For a cached, refcounted factory (shared handles, grace-period teardown), wrap it with `defineDocument` — see below.

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

Replaces the old `.withDocument('content', { content: richText, guid: 'id', onUpdate })` on a table. An app-owned builder + `defineDocument` cache:

```typescript
// apps/fuji/src/lib/entry-content-docs.ts
import {
  attachIndexedDb,
  attachRichText,
  attachSync,
  defineDocument,
  onLocalUpdate,
  toWsUrl,
} from '@epicenter/document';
import * as Y from 'yjs';
import { auth, workspace } from '$lib/client';

function buildEntryContentDoc(entryId: EntryId) {
  const ydoc = new Y.Doc({
    guid: `epicenter.fuji.entries.${entryId}.content`,
    gc: false,
  });

  const content = attachRichText(ydoc);
  const idb = attachIndexedDb(ydoc);
  const sync = attachSync(ydoc, {
    url: (docId) => toWsUrl(`${APP_URLS.API}/docs/${docId}`),
    getToken: async () => auth.token,
    waitFor: idb.whenLoaded,
  });

  // Local-only side effect: bump parent row when the user edits.
  // Filters out remote sync updates so we don't loop.
  onLocalUpdate(ydoc, () => {
    workspace.tables.entries.update(entryId, { updatedAt: DateTimeString.now() });
  });

  return {
    ydoc,
    content,
    idb,
    sync,
    whenReady:    idb.whenLoaded,
    whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed]).then(() => {}),
    [Symbol.dispose]() { ydoc.destroy(); },
  };
}

export const entryContentDocs = defineDocument(buildEntryContentDoc, {
  gcTime: 30_000,
});
```

Component owns the handle; the cache owns identity and the grace-period timer:

```svelte
<script lang="ts">
  import { entryContentDocs } from '$lib/entry-content-docs';
  let { row } = $props();
  $effect(() => {
    using handle = entryContentDocs.open(row.id);  // openCount++
    // [Symbol.dispose] fires on block exit → openCount--; gcTime timer arms
  });
</script>

{#await handle.whenReady}
  <Spinner />
{:then}
  <RichEditor binding={handle.content.binding} />
{/await}
```

Two tabs editing the same entry reconcile at the Yjs layer (IndexedDB + sync). The `defineDocument` cache dedupes in-process handles to the same `entryId`.

## GUID Convention

Every content-doc `Y.Doc` GUID follows a **4-part dotted form**:

```
${workspaceId}.${collection}.${rowId}.${field}
```

| Segment | Owner | Purpose | Example |
|---|---|---|---|
| `workspaceId` | **caller** | globally-unique workspace identity | `epicenter-fuji` |
| `collection` | **package/app** | namespace inside the workspace (not tied to the table name in the workspace schema) | `entries`, `notes`, `files`, `skills`, `references` |
| `rowId` | caller | identifies the row this doc hangs off | `entry_01H…` |
| `field` | **package/app** | which collaborative field this doc holds | `content`, `body`, `instructions` |

Rules:

- **`workspaceId` is required** at the factory level — no defaults. A default collapses IDB namespaces across apps that share a package, so two callers defaulting to the same literal would collide on disk.
- **`collection` is owned by the producer**, not a parameter. `createFileContentDocs` always writes `files` as the collection segment regardless of what the caller named their table. That's the point — the GUID namespace is independent of the workspace schema name.
- **`field` matches the returned key.** If the GUID ends in `.body`, the bundle should expose `{ body }`, not `{ content }`. Keeps domain vocabulary consistent from GUID to call site.
- **Separator is `.`** everywhere. No hyphens, no slashes. Workspace-level docs should follow the same dotted shape (e.g. `${workspaceId}.workspace.${epoch}`) rather than inventing their own separator.

For a package factory shared across apps, the shape is:

```typescript
export function createFileContentDocs({
  workspaceId,   // required — caller's workspace identity
  filesTable,    // caller injects the table to write back to
  persistence = 'indexeddb',
}: {
  workspaceId: string;
  filesTable: Table<FileRow>;
  persistence?: 'indexeddb' | 'none';
}) {
  function buildFileContentDoc(fileId: FileId) {
    const ydoc = new Y.Doc({
      guid: `${workspaceId}.files.${fileId}.content`,  // package owns `files` + `content`
      gc: false,
    });
    // …
  }
  return defineDocument(buildFileContentDoc, { gcTime: 30_000 });
}
```

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
