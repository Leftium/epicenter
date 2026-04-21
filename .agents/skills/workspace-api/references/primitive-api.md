# Primitive API (`@epicenter/workspace`)

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
} from '@epicenter/workspace';
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

> **`attach*` is NOT idempotent.** Hold the reference from the first call. Calling any `attach*` helper twice against the same `Y.Doc` + slot is a caller bug — the framework does not catch it. For observer-installing primitives (`attachTable`, `attachKv`, `attachAwareness`, `attachEncryption`) double-attach silently installs duplicate observers, causing undefined behavior. One attach site per slot, one reference, held for the life of the `Y.Doc`.

## Encrypted Variants (from `@epicenter/workspace`)

For workspaces that need at-rest encryption, the encrypted primitives live in `@epicenter/workspace`:

| Helper | Purpose |
|---|---|
| `attachEncryption(ydoc)` | Per-ydoc encryption coordinator. Returns `{ applyKeys, register, whenDisposed }`. |
| `attachEncryptedTable(ydoc, encryption, name, def)` | Singular encrypted table; self-registers with the coordinator. |
| `attachEncryptedTables(ydoc, encryption, defs)` | Batch sugar over `attachEncryptedTable`. |
| `attachEncryptedKv(ydoc, encryption, defs)` | Encrypted KV singleton. |

Standard composition:

```ts
const ydoc       = new Y.Doc({ guid: id, gc: false });
const encryption = attachEncryption(ydoc);
const tables     = attachEncryptedTables(ydoc, encryption, myTables);
const kv         = attachEncryptedKv(ydoc, encryption, myKv);

// Later, after login:
encryption.applyKeys(session.encryptionKeys);
```

Encryption is opt-in per slot — the verb carries the intent. `attachTable` (plaintext) and `attachEncryptedTable` are both available; pick one per slot.

> **Never mix plaintext and encrypted wrappers on the same slot name.** Yjs returns the same underlying `Y.Array` to `attachTable(ydoc, 'posts', ...)` and `attachEncryptedTable(ydoc, enc, 'posts', ...)` because `ydoc.getArray('table:posts')` is idempotent. If both run, the plaintext wrapper writes plaintext into the same yarray the encrypted wrapper thinks it owns — a silent data-at-rest leak. The framework does not catch this; the grep-able verb (`attachEncrypted*`) is the defense. One slot name, one variant, one intent.

IDB / broadcast / sync / sqlite transitively see already-encrypted bytes after `applyKeys` runs — the Yjs update stream carries ciphertext blobs inside it. No additional encryption setup is needed at those transport layers.

## Readiness Signals: Split, Don't Precompose

Each helper returns what it actually knows. Callers compose at the call site.

- `idb.whenLoaded` — "local draft is in memory, edits are safe" (offline-first UI usually only needs this).
- `sync.whenConnected` — "transport established, first sync exchange finished" (CLIs that need remote state await this).

There is no `whenSynced` composite. If you need both, `Promise.all([idb.whenLoaded, sync.whenConnected])` at the call site. This is intentional — `y-indexeddb`'s upstream `whenSynced` is a misnomer (it's local load, not convergence).

## Canonical Per-Row Content Doc

Replaces the old `.withDocument('content', { content: richText, guid: 'id', onUpdate })` on a table. The builder closure passes directly to `defineDocument` — no named intermediate function, no explicit `gcTime` (30 s is the cache default):

```typescript
// apps/fuji/src/lib/entry-content-docs.ts
import {
  attachIndexedDb,
  attachRichText,
  attachSync,
  defineDocument,
  docGuid,
  onLocalUpdate,
  toWsUrl,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { auth, workspace } from '$lib/client';

export const entryContentDocs = defineDocument((entryId: EntryId) => {
  const ydoc = new Y.Doc({
    guid: docGuid({
      workspaceId: workspace.id,  // no literal prefix — comes from the workspace
      collection: 'entries',
      rowId: entryId,
      field: 'content',
    }),
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
  return defineDocument((fileId: FileId) => {
    const ydoc = new Y.Doc({
      guid: docGuid({ workspaceId, collection: 'files', rowId: fileId, field: 'content' }),
      gc: false,
    });
    // …
  });
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
- `apps/fuji/src/lib/entry-content-docs.ts` — canonical per-row example
- `packages/workspace/src/workspace/create-workspace.ts` — `createWorkspace` built on raw Y.Doc + helpers
