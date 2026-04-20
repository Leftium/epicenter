# @epicenter/document

Low-level Yjs primitives: typed handles and providers that you `attach*` onto a `Y.Doc`. Everything in this package operates on a doc you already own — no encryption, no extensions, no workspace lifecycle. For those, reach for `@epicenter/workspace`.

## Mental model

A `Y.Doc` has two surfaces:

```
┌──────────────────────────────────────────────────────────────┐
│                         Y.Doc                                │
│                                                              │
│   Shared types (the data itself)    Update stream (events)   │
│   ┌─────────────────────────┐       ┌────────────────────┐   │
│   │ Y.XmlFragment 'content' │       │   'update' bus     │   │
│   │ Y.Array 'table:posts'   │       │   'destroy' bus    │   │
│   │ Y.Array '_kv'           │       │                    │   │
│   │ Y.Text 'notes'          │       │                    │   │
│   └──────────▲──────────────┘       └──────▲─────────────┘   │
└──────────────┼─────────────────────────────┼─────────────────┘
               │                             │
        reaches INTO the doc          LISTENS to the doc
        to grab a typed slot          (doesn't add data)
               │                             │
        ┌──────┴──────────┐          ┌───────┴─────────┐
        │ attachRichText  │          │ attachIndexedDb │
        │ attachPlainText │          │ attachSync      │
        │ attachTable     │          │ attachAwareness │
        │ attachKv        │          │                 │
        └─────────────────┘          └─────────────────┘
            HANDLES                      PROVIDERS
```

**Handles** reach into `ydoc.getXmlFragment(...)` / `ydoc.getArray(...)` / `ydoc.getText(...)` and return a typed wrapper. They reserve a named slot in the doc and give you a read/write API. Synchronous, cheap, no teardown of their own — destroying the `Y.Doc` is enough.

**Providers** don't put data *in* the doc. They subscribe to the doc's `update` event, serialize those bytes somewhere (IndexedDB, a WebSocket), and replay updates back in via `Y.applyUpdate`. They don't know or care which shared type produced an update.

This split is the whole design. Yjs's update stream is oblivious to which shared type emitted a change — every mutation is an opaque `Uint8Array`. That means providers are fully decoupled from handles: add `attachPlainText` next to your existing `attachRichText` and neither `attachIndexedDb` nor `attachSync` changes.

> **Note on `attachAwareness`.** It's grouped with providers because it sits *alongside* the doc rather than inside it, but it's the odd one out: awareness state (cursors, presence, typing indicators) is ephemeral and travels on a separate `y-protocols` channel, not the doc's update stream. `attachIndexedDb` and `attachSync` do not persist or sync awareness — sync providers may opt in to forwarding it as a separate message type.

## Quick start

```ts
import {
  attachRichText,
  attachIndexedDb,
  attachSync,
  toWsUrl,
} from '@epicenter/document';
import * as Y from 'yjs';

const ydoc = new Y.Doc({ guid: 'my-note', gc: false });

const content = attachRichText(ydoc);                  // handle
const idb     = attachIndexedDb(ydoc);                 // provider
const sync    = attachSync(ydoc, {                     // provider
  url: (id) => toWsUrl(`wss://api.example/docs/${id}`),
  getToken: async () => token,
  waitFor: idb.whenLoaded,
});

await idb.whenLoaded;
content.write('Hello');

// Teardown: destroying the doc tears down every attachment.
ydoc.destroy();
```

## Sequencing

Order *almost* doesn't matter — handles and providers commute. The one constraint: **providers that hydrate local state should load before providers that push to the network.** Otherwise you may ship an empty doc to the server and clobber remote state.

```ts
const idb  = attachIndexedDb(ydoc);
const sync = attachSync(ydoc, {
  waitFor: idb.whenLoaded,   // ← sync waits for IDB to replay
  ...
});
```

`waitFor` is the only place this ordering shows up in the API.

## The attachments

### Handles

| Function | Yjs slot | Returns |
|---|---|---|
| `attachRichText(ydoc, key?)` | `Y.XmlFragment` at `key` (default `'content'`) | `{ binding, read, write }` for ProseMirror/Tiptap |
| `attachPlainText(ydoc, key?)` | `Y.Text` at `key` (default `'content'`) | `{ binding, read, write }` |
| `attachTable(ydoc, name, def)` | `Y.Array` at `table:<name>` wrapped as `YKeyValueLww` | `TableHelper` — schema-validated CRUD |
| `attachKv(ydoc, defs)` | `Y.Array` at `KV_KEY` wrapped as `YKeyValueLww` | `KvHelper` — typed key→value |
| `attachAwareness(ydoc, defs)` | `y-protocols` `Awareness` (not stored in the doc) | Typed presence helper |

### Providers

| Function | Transport | Returns |
|---|---|---|
| `attachIndexedDb(ydoc)` | `y-indexeddb` keyed by `ydoc.guid` | `{ whenLoaded, clearLocal, disposed }` |
| `attachSync(ydoc, cfg)` | WebSocket via `@epicenter/sync` | `{ whenConnected, status, onStatusChange, reconnect, disposed }` |

Also exported: `toWsUrl(httpUrl)` — a small utility that rewrites `http(s):` to `ws(s):`. Handy when the app knows its API as an HTTP origin and wants to derive the WebSocket URL for `attachSync`.

## Lifecycle

Every attachment hooks into `ydoc.destroy()`. You own the `Y.Doc`; tear it down once and everything unwinds:

```ts
const ydoc = new Y.Doc(...);
const idb  = attachIndexedDb(ydoc);
const sync = attachSync(ydoc, ...);

// Later:
ydoc.destroy();
await Promise.all([idb.disposed, sync.disposed]); // optional — CLIs/tests
```

Handles have no async teardown. Providers return `disposed` promises for code paths that need to flush before exit.

## Gotchas

**`gc: false` when the doc syncs to peers.** Yjs garbage-collects deletion markers by default. If peer A deletes something and its local Yjs compacts the tombstone away before peer B has seen the delete, B's edit can resurrect the deleted content (or fail to converge). Any doc that goes over the wire — every example in this README, including Fuji's per-entry doc — should be constructed with `new Y.Doc({ guid, gc: false })`. Local-only docs can leave GC on.

**Encryption lives one layer up (in `@epicenter/workspace`), and it's narrower than you'd think.** Workspace's encryption wraps the `YKeyValueLww` store — the thing that backs `attachTable` and `attachKv` — by encrypting each value before it hits the Y.Array. It does **not** encrypt the `Y.Doc` update stream, and it does **not** cover `Y.XmlFragment` or `Y.Text` content. A rich-text editor built on workspace with `attachRichText` has encrypted tables/KV but plaintext document content. If you need end-to-end-encrypted rich text, you'll need a different approach (e.g. a separate encrypted blob store keyed by row, with the content doc holding only an opaque pointer). This asymmetry exists because encrypting arbitrary Yjs updates breaks CRDT merging — the server can't merge opaque bytes — whereas encrypting discrete values in a KV store preserves the store's LWW semantics.

## When to use this vs `@epicenter/workspace`

Reach for `@epicenter/document` when you want a single purpose-built doc — a per-entry rich-text buffer, an inspector panel, a scratch Y.Text — and you want explicit control of the `Y.Doc` lifecycle.

Reach for `@epicenter/workspace` when you want a long-lived app database with tables, KV, encryption, extensions (persistence/sync wired together), queries, mutations, and awareness. Workspace is a composed client built on these same primitives, plus encryption wrappers and extension lifecycle.

A real app uses both: workspace for the main data store, document for per-row content docs.

## Real call site

From Fuji's per-entry rich-text editor (`apps/fuji/src/lib/entry-content-doc.ts`):

```ts
export function openEntryContentDoc(rowId: EntryId) {
  const ydoc = new Y.Doc({
    guid: `epicenter.fuji.entries.${rowId}.content`,
    gc: false,
  });

  const content = attachRichText(ydoc);
  const idb     = attachIndexedDb(ydoc);
  const sync    = attachSync(ydoc, {
    url: (id) => toWsUrl(`${APP_URLS.API}/docs/${id}`),
    getToken: async () => auth.token,
    waitFor: idb.whenLoaded,
  });

  ydoc.on('update', () => workspace.tables.entries.update(rowId, {
    updatedAt: DateTimeString.now(),
  }));

  return {
    ydoc,
    content,
    whenLoaded: idb.whenLoaded,
    whenConnected: sync.whenConnected,
    dispose: () => ydoc.destroy(),
  };
}
```

Five lines, five independent concerns — doc, rich-text slot, local persistence, network sync, side-effect on edit. The only coupling between them is the `ydoc` variable they all share.
