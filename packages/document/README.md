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

## Prefix vocabulary

Every exported function in this package (and its sibling `@epicenter/workspace`) falls into one of three verbs. The prefix tells you what the function *does to state*:

| Verb | Side effect | Input | Output | Examples |
|---|---|---|---|---|
| `define*` | **None** — pure data | Schemas, defaults | Plain config object | `defineDocument`, `defineTable`, `defineKv`, `defineMutation` |
| `attach*` | **Mutates a Y.Doc** — binds a slot, registers `ydoc.on('destroy')` | An existing `Y.Doc` + config | Typed handle (non-idempotent — hold the reference) | `attachTable`, `attachKv`, `attachRichText`, `attachIndexedDb`, `attachSync`, `attachEncryption` |
| `create*` | **Instantiates a runtime** — may allocate a `Y.Doc` or wrap an existing store | Config or an existing store | A usable instance or factory | `createWorkspace`, `createPerRowDoc`, `createTable` / `createKv` (internal) |

A few consequences fall out of this:

- `defineTable(schema)` is a **schema**, not a helper — you can declare it at module scope, share it across tests, serialize it, etc. `attachTable(ydoc, name, def)` is what makes it live.
- `attach*` is not idempotent. Two calls against the same `Y.Doc` + slot install duplicate observers and corrupt state silently. Hold the first reference for the lifetime of the `Y.Doc`.
- `create*` that allocates (`createWorkspace`, `createPerRowDoc`) returns something with its own disposal surface. `create*` that wraps (internal `createTable`, `createKv`) is a pure factory over a pre-constructed store.

When you see a verb that doesn't fit one of these three, that's a naming bug — flag it.

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
| `attachIndexedDb(ydoc)` | `y-indexeddb` keyed by `ydoc.guid` | `{ whenLoaded, clearLocal, whenDisposed }` |
| `attachSync(ydoc, cfg)` | WebSocket via `@epicenter/sync` | `{ whenConnected, status, onStatusChange, reconnect, whenDisposed }` |

Also exported: `toWsUrl(httpUrl)` — a small utility that rewrites `http(s):` to `ws(s):`. Handy when the app knows its API as an HTTP origin and wants to derive the WebSocket URL for `attachSync`.

## Lifecycle

Every attachment hooks into `ydoc.destroy()`. You own the `Y.Doc`; tear it down once and everything unwinds:

```ts
const ydoc = new Y.Doc(...);
const idb  = attachIndexedDb(ydoc);
const sync = attachSync(ydoc, ...);

// Later:
ydoc.destroy();
await Promise.all([idb.whenDisposed, sync.whenDisposed]); // optional — CLIs/tests
```

Handles have no async teardown. Providers return `whenDisposed` promises for code paths that need to flush before exit.

**`attach*` is not idempotent.** Hold the reference from the first call. Calling `attachTable` / `attachKv` / `attachAwareness` / `attachEncryption` twice on the same `Y.Doc` + slot installs duplicate observers and causes undefined behavior. The framework does not catch this.

## Gotchas

**`gc: false` when the doc syncs to peers.** Yjs garbage-collects deletion markers by default. If peer A deletes something and its local Yjs compacts the tombstone away before peer B has seen the delete, B's edit can resurrect the deleted content (or fail to converge). Any doc that goes over the wire — every example in this README, including Fuji's per-entry doc — should be constructed with `new Y.Doc({ guid, gc: false })`. Local-only docs can leave GC on.

**Encryption lives one layer up (in `@epicenter/workspace`), and it's narrower than you'd think.** Workspace's encryption wraps the `YKeyValueLww` store — the thing that backs `attachTable` and `attachKv` — by encrypting each value before it hits the Y.Array. It does **not** encrypt the `Y.Doc` update stream, and it does **not** cover `Y.XmlFragment` or `Y.Text` content. A rich-text editor built on workspace with `attachRichText` has encrypted tables/KV but plaintext document content. If you need end-to-end-encrypted rich text, you'll need a different approach (e.g. a separate encrypted blob store keyed by row, with the content doc holding only an opaque pointer). This asymmetry exists because encrypting arbitrary Yjs updates breaks CRDT merging — the server can't merge opaque bytes — whereas encrypting discrete values in a KV store preserves the store's LWW semantics.

## When to use this vs `@epicenter/workspace`

Reach for `@epicenter/document` when you want a single purpose-built doc — a per-entry rich-text buffer, an inspector panel, a scratch Y.Text — and you want explicit control of the `Y.Doc` lifecycle.

Reach for `@epicenter/workspace` when you want a long-lived app database with tables, KV, encryption, extensions (persistence/sync wired together), queries, mutations, and awareness. Workspace is a composed client built on these same primitives, plus encryption wrappers and extension lifecycle.

A real app uses both: workspace for the main data store, document for per-row content docs.

## Real call site

From Fuji's per-entry rich-text editor (`apps/fuji/src/lib/entry-content-docs.ts`) — the builder closure passes directly to `defineDocument`:

```ts
import {
  attachIndexedDb,
  attachRichText,
  attachSync,
  defineDocument,
  docGuid,
  onLocalUpdate,
  toWsUrl,
} from '@epicenter/document';

export const entryContentDocs = defineDocument((entryId: EntryId) => {
  const ydoc = new Y.Doc({
    guid: docGuid({
      workspaceId: workspace.id,
      collection: 'entries',
      rowId: entryId,
      field: 'content',
    }),
    gc: false,
  });

  const content = attachRichText(ydoc);
  const idb     = attachIndexedDb(ydoc);
  const sync    = attachSync(ydoc, {
    url: (id) => toWsUrl(`${APP_URLS.API}/docs/${id}`),
    getToken: async () => auth.token,
    waitFor: idb.whenLoaded,
  });

  // Local-only: filters out remote sync updates so we don't loop.
  onLocalUpdate(ydoc, () => workspace.tables.entries.update(entryId, {
    updatedAt: DateTimeString.now(),
  }));

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

Five attachments, five independent concerns — doc, rich-text slot, local persistence, network sync, local-update side effect. The only coupling between them is the `ydoc` variable they share. `defineDocument` adds identity + refcounting on top without changing the builder.

### GUID convention

Content-doc GUIDs follow a 4-part dotted form: `${workspaceId}.${collection}.${rowId}.${field}`. The `workspaceId` segment is owned by the caller (and must be globally unique — no package-level defaults, since IDB namespaces collide across apps). The `collection` and `field` segments are owned by the producer and are independent of the caller's workspace schema names. See the workspace-api skill's `document-primitive` reference for the full rules.
