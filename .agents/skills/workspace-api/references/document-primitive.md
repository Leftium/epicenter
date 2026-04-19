# Document Primitive (`@epicenter/document`)

## When to Read This

Read when composing standalone Y.Docs (per-row content, settings, skills, anything outside `createWorkspace`), or when wiring persistence + sync against a raw `Y.Doc`.

`.withDocument()` on tables was removed. Per-row content docs are now regular `defineDocument`s opened by the component that owns the lifecycle.

## The Primitive

```typescript
import { defineDocument, openDocument } from '@epicenter/document';

const def = defineDocument('my.doc.id', (ydoc) => {
  // bootstrap runs once when openDocument() is called
  return { /* public API */ };
});

const handle = openDocument(def);  // SYNC — no top-level await
handle.dispose();                  // fires ydoc.destroy()
```

- `defineDocument(id, bootstrap, { gc? })` — inert definition. No Y.Doc allocated.
- `openDocument(def)` — allocates the Y.Doc (`guid: def.id`, `gc: false` by default), runs `bootstrap`, returns `bootstrap`'s return value plus `{ ydoc, dispose }`.
- `gc` defaults to `false` — GC of deletion markers breaks sync with peers that haven't seen the deletes. Only flip to `true` for purely local, short-lived docs.
- Bootstrap errors auto-destroy the Y.Doc (fires `'destroy'` so anything registered cleans up), then rethrow.

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
import {
  attachIndexedDb, attachRichText, attachSync,
  defineDocument, openDocument, toWsUrl,
} from '@epicenter/document';
import { workspace, auth } from './client';

export function openEntryContentDoc(rowId: EntryId) {
  return openDocument(entryContentDoc(rowId));
}

function entryContentDoc(rowId: EntryId) {
  return defineDocument(`epicenter.fuji.entries.${rowId}.content`, (ydoc) => {
    const content = attachRichText(ydoc);
    const idb  = attachIndexedDb(ydoc);
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
      content,
      whenLoaded:    idb.whenLoaded,
      whenConnected: sync.whenConnected,
      whenDisposed:  Promise.all([idb.disposed, sync.disposed]).then(() => {}),
      clearLocal:    idb.clearLocal,
      reconnect:     sync.reconnect,
    };
  });
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

`openDocument` evaluated at module scope becomes a singleton via ES module caching — no registry needed:

```typescript
// packages/skills/src/doc.ts
export const skills = openDocument(skillsDoc);  // evaluated once per graph
```

Synchronous open means no top-level-await propagation, trivially mockable in tests.

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
defineDocument('...', bootstrap, { gc: true });  // peers lose deletion markers

// ✅ Default (gc: false) — only opt in for purely local ephemeral docs
```

## Relationship to `createWorkspace`

`createWorkspace` is the single-Y.Doc sugar: one workspace def, one Y.Doc, one `.withExtension` chain. Under the hood, workspace extensions are thin closures over the same attach helpers. If your app fits in one Y.Doc, keep using `createWorkspace` — it hasn't changed. Reach for `defineDocument` when you need a second scope: per-row content, split settings, skills, or any non-workspace Yjs doc.

## Code References

- `packages/document/src/define-document.ts` — primitive + test
- `packages/document/src/attach-indexed-db.ts` — persistence attach
- `packages/document/src/attach-sync.ts` — sync attach (supervisor, backoff, awareness)
- `packages/document/src/attach-rich-text.ts`, `attach-plain-text.ts`
- `apps/fuji/src/lib/entry-content-doc.ts` — canonical per-row example
