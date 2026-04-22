# Workspace Document API

A typed interface over Y.js for apps that need to evolve their data schema over time.

## The Idea

This is a wrapper around Y.js that handles schema versioning. Local-first apps can't run migration scripts, so data has to evolve gracefully. Old data coexists with new. The Workspace API bakes that into the design: define your schemas once with versions, write a migration function, and everything else is typed.

The canonical primitive is `defineDocument(builder)`. You own the `Y.Doc` construction and compose every capability (tables, KV, persistence, sync, encryption, awareness) inline with `attach*` primitives. There is no framework convention for the shape of your returned bundle — you return whatever your app needs.

```
┌────────────────────────────────────────────────────────────┐
│  Your App                                                  │
├────────────────────────────────────────────────────────────┤
│  defineDocument((id) => { ydoc, tables, ...; dispose })    │ ← Public primitive
│  ↓ .open(id) → your bundle                                 │
├────────────────────────────────────────────────────────────┤
│  attachTable / attachTables / attachKv                     │ ← Data attachments
│  attachEncryption / attachEncryptedTables / attachEncryptedKv
│  attachAwareness                                           │ ← Presence
│  attachIndexedDb / attachSqlite / attachBroadcastChannel   │ ← Persistence + cross-tab
│  attachSync                                                │ ← WebSocket sync
│  createSqliteMaterializer                                  │ ← Queryable mirror
├────────────────────────────────────────────────────────────┤
│  Y.Doc (raw CRDT)                                          │ ← Escape hatch
└────────────────────────────────────────────────────────────┘
```

## The Pattern: define vs attach vs create

Three prefixes, each with a consistent meaning:

- **`define*`** is pure — no Y.Doc, no side effects. Schemas, KV definitions, action factories, document factories.
- **`attach*`** binds something to an existing `Y.Doc`. Returns a typed handle. Side effects live here.
- **`create*`** instantiates a helper from already-attached pieces (`createSqliteMaterializer`, `createFileContentDocs`, etc.).

```typescript
import * as Y from 'yjs';
import { defineTable, defineDocument, attachTable } from '@epicenter/workspace';
import { type } from 'arktype';

// Pure schema
const postsTable = defineTable(type({ id: 'string', title: 'string', _v: '1' }));

// Document factory: owns Y.Doc creation, composes attachments
const blog = defineDocument((id: string) => {
  const ydoc = new Y.Doc({ guid: id });
  const tables = {
    posts: attachTable(ydoc, 'posts', postsTable),
  };
  return {
    id,
    ydoc,
    tables,
    [Symbol.dispose]() { ydoc.destroy(); },
  };
});

const workspace = blog.open('blog');
workspace.tables.posts.set({ id: '1', title: 'Hello', _v: 1 });
```

## Composing More

The builder closure is where you wire everything. Because you own the return shape, you can expose whatever handles your app needs.

### Encryption (client-side E2E)

```typescript
import {
  attachEncryption,
  attachEncryptedTables,
  attachEncryptedKv,
} from '@epicenter/workspace';

const factory = defineDocument((id) => {
  const ydoc = new Y.Doc({ guid: id });
  const encryption = attachEncryption(ydoc);
  const tables = attachEncryptedTables(ydoc, encryption, myTables);
  const kv = attachEncryptedKv(ydoc, encryption, myKv);
  return { id, ydoc, tables, kv, encryption, [Symbol.dispose]() { ydoc.destroy(); } };
});
```

### Persistence + sync

```typescript
import {
  attachIndexedDb,
  attachBroadcastChannel,
  attachSync,
} from '@epicenter/workspace';

const factory = defineDocument((id) => {
  const ydoc = new Y.Doc({ guid: id });
  const tables = attachTables(ydoc, myTables);

  const idb = attachIndexedDb(ydoc);
  attachBroadcastChannel(ydoc);
  const sync = attachSync(ydoc, {
    url: (docId) => `wss://api.example.com/workspaces/${docId}`,
    getToken: async () => auth.token,
    waitFor: idb.whenLoaded,
  });

  return {
    id, ydoc, tables, idb, sync,
    whenReady: idb.whenLoaded,
    [Symbol.dispose]() { ydoc.destroy(); },
  };
});
```

### Awareness

```typescript
import { attachAwareness } from '@epicenter/workspace';

const awareness = attachAwareness(ydoc, myAwarenessDefs);
// awareness.setLocal({...}), awareness.observe(...), awareness.raw for y-protocols
```

### Per-row content documents

Tables stay lean (ids, titles, metadata). Rich content lives in a separate `defineDocument` factory keyed on the row's content guid. The row holds the guid; the content factory opens a Y.Doc per row on demand. See `apps/fuji/src/lib/entry-content-doc.ts` for the canonical pattern.

## Design Decisions

**Row-level atomicity.** `set()` replaces the entire row. No field-level updates. Every write is a complete row in the latest schema.

**Migration on read, not on write.** Old data transforms when loaded, not when written. Old rows stay old in storage until explicitly rewritten.

**No write validation.** Writes aren't validated at runtime. TypeScript ensures shape; reads validate and return invalid on corruption.

**No field-level observation.** Observe entire tables or KV keys. Let your UI framework handle field reactivity.

**Why `_v` instead of `v`.** Framework metadata prefix — same convention as `_id` in MongoDB. Users intuitively avoid underscore-prefixed fields for business data.

## Testing

Tests live in `*.test.ts` next to the implementation. Use `new Y.Doc()` for in-memory tests. Migrations are validated by reading old data and checking the result.

## Canonical references

- `apps/whispering/src/lib/client.ts` — encryption + IndexedDB + BroadcastChannel + per-row materialization
- `apps/fuji/src/lib/client.ts` — encryption + IndexedDB + sync + awareness
- `packages/workspace/README.md` — quick start
- `packages/workspace/SYNC_ARCHITECTURE.md` — multi-device sync design
