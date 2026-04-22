# Epicenter: YJS-First Collaborative Workspace System

The hard problem with local-first apps is synchronization. If each device has its own SQLite file, how do you keep them in sync? If each device has its own markdown folder, same question.

`@epicenter/workspace` solves that by making Yjs the source of truth. Tables, KV entries, document content, and awareness all live in a `Y.Doc`; persistence, sync, and materializers hang off that core as attachment primitives. Write to the workspace, and everything else reacts.

The public path is `defineDocument(buildBundle)` — a small refcounted cache around a user-owned builder that composes `new Y.Doc`, `attachTables`, `attachKv`, `attachIndexedDb`, `attachSync`, and so on. Everything below — tables, KV, documents, sync — is just what you return from that builder.

## Quick Start

```bash
bun add @epicenter/workspace
```

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachIndexedDb,
	attachKv,
	attachSync,
	attachTables,
	defineDocument,
	defineTable,
	toWsUrl,
} from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		body: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

const blog = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { posts });
	const kv = attachKv(ydoc, {});
	const idb = attachIndexedDb(ydoc);
	const sync = attachSync(ydoc, {
		url: (docId) => toWsUrl(`http://localhost:3913/rooms/${docId}`),
		waitFor: idb.whenLoaded,
	});

	return {
		id,
		ydoc,
		tables,
		kv,
		idb,
		sync,
		whenReady: idb.whenLoaded,
		whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed]).then(
			() => {},
		),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

// Singleton style: open once at module scope, use everywhere.
export const blogWorkspace = blog.open('epicenter.blog');

// Multi-doc style: load by id, dispose when done.
// await using draft = await blog.load(`draft:${id}`);

async function quickStart() {
	await blogWorkspace.whenReady;

	blogWorkspace.tables.posts.set({
		id: 'welcome',
		title: 'Hello World',
		body: 'This row lives in the Y.Doc.',
		published: false,
		_v: 1,
	});

	const result = blogWorkspace.tables.posts.get('welcome');
	if (result.status === 'valid') {
		blogWorkspace.tables.posts.update(result.row.id, { published: true });
	}
}

void quickStart;
```

That example uses the current public API end to end:

- `defineTable(...)` with a real schema
- `defineDocument(builder)` + `.open(id)` for the live handle
- `attachTables` / `attachKv` / `attachIndexedDb` / `attachSync` composed inline
- direct property access via `workspace.tables.posts`
- `set`, `get`, `update`, `delete`, `getAllValid`, and `observe`

`defineDocument` serves both cases with one primitive. A singleton like the blog above is just `.open(id)` called once; a multi-document app (per-row content docs, per-room ephemeral docs) calls `.open(id)` N times — the cache refcounts handles and disposes them after a `gcTime` grace period once the last handle is released.

## Prefix vocabulary

Every exported function in this package falls into one of three verbs. The prefix tells you what the function *does to state*:

| Verb | Side effect | Input | Output | Examples |
|---|---|---|---|---|
| `define*` | **None** — pure data | Schemas, defaults | Plain config object / refcounted cache | `defineTable`, `defineKv`, `defineDocument`, `defineMutation`, `defineQuery` |
| `attach*` | **Mutates a Y.Doc** — binds a slot, registers `ydoc.on('destroy')` | An existing `Y.Doc` + config | Typed handle (non-idempotent — hold the reference) | `attachTable`, `attachTables`, `attachKv`, `attachRichText`, `attachPlainText`, `attachTimeline`, `attachAwareness`, `attachIndexedDb`, `attachSqlite`, `attachBroadcastChannel`, `attachSync`, `attachEncryption` (with `.attachTable` / `.attachTables` / `.attachKv` methods) |
| `create*` | **Pure construction** — no listeners, no subscriptions, no destroy registration at call time. Paired with an `attach*` sibling: the `create*` makes a slot definition, the `attach*` wires it into a ydoc. | Definitions or schemas | A usable definition / instance | `createTable`, `createKv`, `createAwareness`, `createUnionSchema` |

`defineDocument(builder)` is the top-level entry point. The user owns `new Y.Doc` and every `attach*` call inside the builder; the cache owns identity (keyed by id), refcount, and the `gcTime` grace period between last-dispose and teardown. `.open(id)` returns a disposable handle.

### Plaintext vs encrypted

Both variants ship from this package. Plaintext (`attachTable`, `attachTables`, `attachKv`) binds a typed helper directly to the Y.Doc. Encrypted — the methods on the `EncryptionAttachment` coordinator returned by `attachEncryption(ydoc)` (`encryption.attachTable`, `encryption.attachTables`, `encryption.attachKv`) — additionally registers its backing store with that coordinator so keys applied via `encryption.applyKeys(...)` flow to every registered store atomically.

Don't mix plaintext and encrypted wrappers on the same slot name — Yjs hands both calls the same underlying `Y.Array` and you get a silent plaintext-over-ciphertext race. The verb (`encryption.attachTable` vs plain `attachTable`) is the primary defense; review call sites accordingly. One slot name, one attach site, one intent.

Minimal encrypted workspace — encryption + IndexedDB + cross-tab + sync wired end-to-end:

```typescript
import {
	attachBroadcastChannel,
	attachEncryption,
	attachIndexedDb,
	attachSync,
	defineDocument,
	toWsUrl,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { appTables } from '$lib/workspace/definition';

const app = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id, gc: false });

	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, appTables);

	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);
	const sync = attachSync(ydoc, {
		url: (docId) => toWsUrl(`https://api.epicenter.so/workspaces/${docId}`),
		getToken: async () => auth.token,
		waitFor: idb.whenLoaded,
	});

	return {
		id, ydoc, tables, encryption, idb, sync,
		whenReady: idb.whenLoaded,
		whenDisposed: Promise.all([
			idb.whenDisposed,
			sync.whenDisposed,
			encryption.whenDisposed,
		]).then(() => {}),
		[Symbol.dispose]() { ydoc.destroy(); },
	};
});

export const workspace = app.open('epicenter.my-app');

// On login: workspace.encryption.applyKeys(session.encryptionKeys); workspace.sync.reconnect();
// On logout: await workspace.idb.clearLocal();
```

The `id` passed to `app.open(...)` becomes `ydoc.guid`, which becomes the sync room name. Namespace it to your app (e.g. `epicenter.my-app`) to avoid collisions when multiple apps share the same IndexedDB origin.

For a production-shaped wiring (with device registration, auth integration, etc.), see `apps/tab-manager/src/lib/client.ts`.

## Core Philosophy

### Yjs is the source of truth

Epicenter keeps the write path brutally simple: the `Y.Doc` is authoritative. Tables and KV are just typed helpers over Yjs collections, and document content is a Yjs timeline. Sync providers, SQLite mirrors, and markdown files are all derived from that core.

That matters because conflict resolution only has to happen once. Yjs handles merge semantics; extensions react to the merged state.

### Definitions are pure; clients are live

`defineTable` and `defineKv` are pure. They do not create a `Y.Doc`, open a socket, or touch IndexedDB. The builder you pass to `defineDocument(...)` is the boundary where the live bundle appears.

That split is not cosmetic. It lets you share definitions across modules, infer types once, and instantiate different bundles in different runtimes without rewriting the schema layer.

### Inline composition is the extension system

There is no builder chain. The user-owned builder inside `defineDocument` composes attachments inline:

```typescript
defineDocument((id) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { posts });
	const idb = attachIndexedDb(ydoc);
	const sync = attachSync(ydoc, { url, waitFor: idb.whenLoaded });
	return { id, ydoc, tables, idb, sync, /* ... */ };
});
```

Ordering is obvious (later `attach*` calls see earlier ones through plain lexical scope) and there is no magic `client.extensions` namespace — each attachment is whatever you named it in the returned bundle.

### Read-time validation beats write-time ceremony

Tables validate and migrate on read, not on write. `set(...)` writes the row shape TypeScript already approved. `get(...)` is where invalid old data shows up as `{ status: 'invalid' }` and old versions are migrated to the latest schema.

That trade-off is deliberate. It keeps the write path cheap and pushes schema evolution into one place—the table definition.

### Storage scales with active data, not edit history

With Yjs garbage collection enabled, storage tracks the live document much more closely than the number of operations that happened over time. Deleted rows, overwritten values, and old content states collapse down to compact metadata. The workspace grows because you keep more data—not because you clicked save a thousand times.

## Architecture Overview

### The Y.Doc: Heart of Every Workspace

Every piece of data lives in a `Y.Doc`, which provides conflict-free merging, real-time collaboration, and offline-first operation:

```
┌─────────────────────────────────────────────────────────────┐
│                      Y.Doc (CRDT)                            │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Y.Array('table:posts')  <- LWW entries per table      │  │
│  │   └── { key: id, val: { fields... }, ts: number }     │  │
│  │                                                        │  │
│  │ Y.Array('table:users')  <- Another table              │  │
│  │   └── { key: id, val: { fields... }, ts: number }     │  │
│  │                                                        │  │
│  │ Y.Array('kv')  <- Settings as LWW entries             │  │
│  │   └── { key: name, val: value, ts: number }           │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

Note: Schema definitions are stored in static TypeScript modules, not in the Y.Doc.
The Y.Doc carries data. Your definition files carry meaning.
```

### Three-Layer Data Flow

```
┌────────────────────────────────────────────────────────────────────┐
│  WRITE FLOW                                                         │
│                                                                     │
│  App code / action → Y.Doc updated → Extensions react              │
│                       │                                             │
│              ┌────────┼────────┐                                    │
│              ▼        ▼        ▼                                    │
│         IndexedDB  WebSocket  Markdown                              │
│         or SQLite   sync      materializer                          │
└────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────┐
│  READ FLOW                                                          │
│                                                                     │
│  Simple reads → table / kv helpers over Y.Doc                       │
│  Rich text  → document handles over timeline Y.Docs                 │
│  Derived reads → extension exports built on the same core           │
└────────────────────────────────────────────────────────────────────┘
```

### Multi-Device Sync Topology

Epicenter supports distributed sync where Y.Doc instances replicate across devices via y-websocket:

```
   PHONE                   LAPTOP                    DESKTOP
   ┌──────────┐           ┌──────────┐              ┌──────────┐
   │ Browser  │           │ Browser  │              │ Browser  │
   │ Y.Doc    │           │ Y.Doc    │              │ Y.Doc    │
   └────┬─────┘           └────┬─────┘              └────┬─────┘
        │                      │                         │
   (no server)            ┌────▼─────┐              ┌────▼─────┐
        │                 │ Elysia   │◄────────────►│ Elysia   │
        │                 │ :3913    │  server-to-  │ :3913    │
        │                 └────┬─────┘    server    └────┬─────┘
        │                      │                         │
        └──────────────────────┴─────────────────────────┘
                           Connect to multiple nodes
```

Yjs supports multiple providers simultaneously. A phone can connect to desktop, laptop, and cloud at the same time; CRDT merge semantics do the rest.

### How It All Fits Together

1. Define tables and KV entries with `defineTable` and `defineKv`.
2. Write a builder that takes an `id`, constructs `new Y.Doc({ guid: id })`, and composes `attachTables` / `attachKv` / `attachIndexedDb` / `attachSync` / etc. inline.
3. Wrap the builder with `defineDocument(builder)` to get a refcounted cache.
4. Call `.open(id)` to get a live handle immediately (reactive/UI callers that subscribe before readiness), or `await .load(id)` when imperative code needs a handle that's already past `whenReady`.
5. For `.open(id)` callers: `await handle.whenReady` before reading persisted state. `.load(id)` returns a handle already past that barrier.
6. Read and write through `handle.tables`, `handle.kv`, `handle.awareness`, and (for per-row content docs) whatever you exposed in the returned bundle.
7. Use `iterateActions(...)` and each action's metadata (`type`, `title`, `description`, `input`) if you want to build adapters such as HTTP, CLI, or MCP.
8. Dispose with `handle[Symbol.dispose]()` (or let a `using` block do it) when you're done — the cache waits `gcTime` before tearing the bundle down in case another caller re-opens it.

The architecture stays local-first: the workspace works offline, synchronizes opportunistically, and treats external systems as helpers around the document—not the other way around.

## Shared Workspace ID Convention

Epicenter uses stable, shared workspace IDs so multiple apps can collaborate on the same data.

- Format: `epicenter.<app>`
- Purpose: stable routing, persistence keys, sync room names, and workspace discovery
- Stability: once published, an ID should not change
- Scope: two apps with the same ID are intentionally pointing at the same workspace

The ID becomes `ydoc.guid` for the workspace doc, so it is not a throwaway string. Pick one and keep it.

## Core Concepts

> **Note on examples below.** Small snippets in this section use a minimal
> `defineDocument((id) => { ... }).open(id)` to keep the focus on the API
> being demonstrated (table CRUD, KV, actions). See the **Quick Start** above
> for a more fully-composed builder with persistence and sync.

### Workspaces

There is only one primitive: `defineDocument(build)`. The `build` closure takes
an `id` and returns a bundle — `{ id, ydoc, tables, kv, awareness, actions,
[Symbol.dispose]() {...}, ... }`. The factory caches bundles by id; `.open(id)`
mints a live refcounted handle whose shape is whatever the builder returned.

### Yjs document

The raw `Y.Doc` is available at `handle.ydoc`. That is the escape hatch, not the primary API. Most consumers should stay at the typed-helper layer unless they are writing a new attachment or debugging storage internals.

### Tables

Tables are versioned row collections. Each row must include:

- `id: string`
- `_v: number`

At runtime, each table becomes a `Table` exposed as a direct property:

- `handle.tables.posts.set(row)`
- `handle.tables.posts.get(id)`
- `handle.tables.posts.update(id, partial)`
- `handle.tables.posts.delete(id)`

Table access is direct property access in the current API.

### KV

KV entries are for settings and scalar preferences. They are keyed by string and always return a valid value because invalid or missing data falls back to the definition's default.

- `handle.kv.get('theme.mode')`
- `handle.kv.set('theme.mode', 'dark')`
- `handle.kv.observe('theme.mode', ...)`

### Attachments (the extension system)

"Extensions" in Epicenter are just `attach*` calls inside your `defineDocument`
builder. There is no `.withExtension` chain, no extension registry, no priority
flag — just lexical scope.

- Call the relevant `attach*` function (e.g. `attachIndexedDb`, `attachSync`, `attachSqlite`, `attachEncryption`) inside the builder and include the handle in the returned bundle.
- Order matters only through lexical scope — later `attach*` calls see earlier handles directly.
- For per-row content docs, write a **separate** `defineDocument((rowId) => ...)` factory and `.open(rowId)` it from the main document's actions or components.

### Actions

Actions are callable functions with metadata.

- `defineQuery(...)` creates a read action
- `defineMutation(...)` creates a write action
- Include them in your builder's return object as `actions: { ... }` (typically via a `createMyAppActions({ tables, batch })` helper defined nearby)

Handlers close over `tables`, `kv`, and anything else the builder has in scope through normal JavaScript closure. They do not receive a framework context object.

### Per-row content documents

For apps where each row has its own rich-text / plain-text / timeline content
(files, notes, skills, entries), define a **second** `defineDocument` factory
keyed by the row id. See **Document-backed tables** below for the full shape.

Each `.open(rowId)` returns a refcounted handle. Multiple consumers (editor,
actions, materializer) can share one underlying Y.Doc safely — the cache owns
construction, refcounting, and `gcTime`-delayed teardown.

```svelte
<script lang="ts">
  import { fileContentDoc } from '$lib/client';

  let { fileId }: { fileId: string } = $props();

  const handle = $derived(fileContentDoc.open(fileId));
  $effect(() => () => handle.dispose());
</script>

<Editor ytext={handle.content} />
```

The `$derived` swaps handles when `fileId` changes; the `$effect` cleanup
releases the old handle. Refcount→0 arms the factory's `gcTime` timer; a fresh
open during the grace window cancels the pending teardown, so rapid navigation
doesn't flap persistence or sync.

## Column Types

The old column builder API is gone. There is no `id()`, `text()`, `boolean()`, `date()`, `select()`, `tags()`, or `json()` in the current package surface.

Today, tables and KV entries are defined with schemas directly.

### Required table fields

Every table row schema must include:

- `id`
- `_v`

In arktype, `_v: '1'` means the numeric literal `1`, not the string `'1'` at runtime.

### Single-version tables

```typescript
import { type } from 'arktype';
import { defineTable } from '@epicenter/workspace';

const users = defineTable(
	type({
		id: 'string',
		email: 'string',
		name: 'string',
		_v: '1',
	}),
);

void users;
```

Use the single-schema form when the table has only one version today.

### Versioned tables

```typescript
import { type } from 'arktype';
import { defineTable } from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		_v: '1',
	}),
	type({
		id: 'string',
		title: 'string',
		slug: 'string',
		_v: '2',
	}),
).migrate((row) => {
		switch (row._v) {
			case 1:
				return {
					...row,
					slug: row.title.toLowerCase().replaceAll(' ', '-'),
					_v: 2,
				};

			case 2:
				return row;
		}
	});

void posts;
```

Migration runs on read. Old rows stay old in storage until you rewrite them.

### KV entries

```typescript
import { type } from 'arktype';
import { defineKv } from '@epicenter/workspace';

const themeMode = defineKv(type("'light' | 'dark' | 'system'"), 'light');
const sidebarWidth = defineKv(type('number'), 280);
const sidebarCollapsed = defineKv(type('boolean'), false);

void themeMode;
void sidebarWidth;
void sidebarCollapsed;
```

KV is validate-or-default. There is no migration function.

### Awareness definitions

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachAwareness,
	attachTables,
	defineDocument,
	defineTable,
} from '@epicenter/workspace';

const notes = defineTable(
	type({
		id: 'string',
		title: 'string',
		_v: '1',
	}),
);

const notesDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { notes });
	const awareness = attachAwareness(ydoc, {
		name: type('string'),
		color: type('string'),
		cursor: type({ line: 'number', column: 'number' }),
	});

	return {
		id,
		ydoc,
		tables,
		awareness,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

const workspace = notesDoc.open('epicenter.notes');

workspace.awareness.setLocal({ name: 'Braden', color: '#ff4d4f' });
workspace.awareness.setLocalField('cursor', { line: 12, column: 3 });
```

### Document-backed tables

Per-row content (one Y.Doc per file/note/entry) is **a second `defineDocument`
factory**, keyed by the row id. The main workspace holds the metadata row; the
content factory owns the content Y.Doc. This is how the filesystem,
opensidian, and fuji apps do it.

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachIndexedDb,
	attachPlainText,
	attachTables,
	defineDocument,
	defineTable,
} from '@epicenter/workspace';

const files = defineTable(
	type({
		id: 'string',
		name: 'string',
		updatedAt: 'number',
		_v: '1',
	}),
);

const filesDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { files });
	const idb = attachIndexedDb(ydoc);

	return {
		id,
		ydoc,
		tables,
		idb,
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

// Separate factory — one Y.Doc per file, keyed by file id.
const fileContentDoc = defineDocument((fileId: string) => {
	const ydoc = new Y.Doc({ guid: `epicenter.files/files/${fileId}/content` });
	const content = attachPlainText(ydoc, 'content');
	const idb = attachIndexedDb(ydoc);

	return {
		id: fileId,
		ydoc,
		content,
		idb,
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

const workspace = filesDoc.open('epicenter.files');

async function documentExample() {
	workspace.tables.files.set({
		id: 'file-1',
		name: 'hello.md',
		updatedAt: Date.now(),
		_v: 1,
	});

	// Load a content handle for the row. Refcounted — dispose when done.
	await using handle = await fileContentDoc.load('file-1');

	handle.content.insert(0, '# Hello from a document');
	console.log(handle.content.toString());
}

void documentExample;
```

Opens are refcounted: multiple callers (editor, filesystem actions,
materializer) can `.open(fileId)` concurrently and share one Y.Doc. The cache
tears the bundle down `gcTime` after the last handle disposes.

## Table Operations

All table operations live on direct properties such as `handle.tables.posts`.

### Write operations

`set(row)` inserts or replaces a whole row.

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachTables,
	defineDocument,
	defineTable,
} from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

const postsDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { posts });
	return {
		id,
		ydoc,
		tables,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

const workspace = postsDoc.open('epicenter.examples.tables');

workspace.tables.posts.set({
	id: 'post-1',
	title: 'First post',
	published: false,
	_v: 1,
});

workspace.tables.posts.set({
	id: 'post-1',
	title: 'First post, replaced',
	published: true,
	_v: 1,
});
```

`set(...)` is the insert-or-replace API.

### Update operations

`update(id, partial)` reads the row, merges the partial fields, validates the merged result, and writes it back.

Possible return values:

- `{ status: 'updated', row }`
- `{ status: 'not_found', id, row: undefined }`
- `{ status: 'invalid', id, errors, row }`

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachTables,
	defineDocument,
	defineTable,
} from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		published: 'boolean',
		views: 'number',
		_v: '1',
	}),
);

const postsDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { posts });
	return {
		id,
		ydoc,
		tables,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

const workspace = postsDoc.open('epicenter.examples.update');

workspace.tables.posts.set({
	id: 'post-1',
	title: 'Draft',
	published: false,
	views: 0,
	_v: 1,
});

const updateResult = workspace.tables.posts.update('post-1', {
	published: true,
	views: 1,
});

if (updateResult.status === 'updated') {
	console.log(updateResult.row.views);
}
```

### Read operations

The table helper has two styles of read:

| Method | Return type | Notes |
| --- | --- | --- |
| `get(id)` | `GetResult<TRow>` | Returns `valid`, `invalid`, or `not_found` |
| `getAll()` | `RowResult<TRow>[]` | Includes invalid rows |
| `getAllValid()` | `TRow[]` | Skips invalid rows |
| `getAllInvalid()` | `InvalidRowResult[]` | Debug schema drift or corrupt data |
| `filter(predicate)` | `TRow[]` | Runs only on valid rows |
| `find(predicate)` | `TRow | undefined` | First valid match |
| `has(id)` | `boolean` | Existence only |
| `count()` | `number` | Counts valid and invalid rows |

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachTables,
	defineDocument,
	defineTable,
} from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

const postsDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { posts });
	return {
		id,
		ydoc,
		tables,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

const workspace = postsDoc.open('epicenter.examples.reads');

workspace.tables.posts.set({ id: '1', title: 'One', published: false, _v: 1 });
workspace.tables.posts.set({ id: '2', title: 'Two', published: true, _v: 1 });

const one = workspace.tables.posts.get('1');
if (one.status === 'valid') {
	console.log(one.row.title);
}

const all = workspace.tables.posts.getAll();
const valid = workspace.tables.posts.getAllValid();
const published = workspace.tables.posts.filter((row) => row.published);
const firstPublished = workspace.tables.posts.find((row) => row.published);
const hasPostTwo = workspace.tables.posts.has('2');
const count = workspace.tables.posts.count();

console.log(all.length, valid.length, published.length, firstPublished?.id, hasPostTwo, count);
```

### Delete operations

| Method | Behavior |
| --- | --- |
| `delete(id)` | Deletes one row; missing IDs are a silent no-op |
| `clear()` | Deletes all rows in the table |

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachTables,
	defineDocument,
	defineTable,
} from '@epicenter/workspace';

const tags = defineTable(
	type({
		id: 'string',
		name: 'string',
		_v: '1',
	}),
);

const tagsDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { tags });
	return {
		id,
		ydoc,
		tables,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

const workspace = tagsDoc.open('epicenter.examples.deletes');

workspace.tables.tags.set({ id: 'tag-1', name: 'important', _v: 1 });
workspace.tables.tags.delete('tag-1');
workspace.tables.tags.clear();
```

### Reactive updates

`observe(...)` reports a set of changed IDs and the optional Yjs transaction origin.

Use `table.get(id)` inside the callback to see whether the row now exists.

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachTables,
	defineDocument,
	defineTable,
	DOCUMENTS_ORIGIN,
} from '@epicenter/workspace';

const files = defineTable(
	type({
		id: 'string',
		name: 'string',
		_v: '1',
	}),
);

const filesDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { files });
	return {
		id,
		ydoc,
		tables,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

const workspace = filesDoc.open('epicenter.examples.observe');

const unsubscribe = workspace.tables.files.observe((changedIds, origin) => {
	if (origin === DOCUMENTS_ORIGIN) {
		return;
	}

	for (const id of changedIds) {
		const result = workspace.tables.files.get(id);
		if (result.status === 'not_found') {
			console.log('deleted:', id);
			continue;
		}

		if (result.status === 'valid') {
			console.log('present:', result.row.name);
		}
	}
});

workspace.tables.files.set({ id: 'file-1', name: 'notes.md', _v: 1 });
workspace.tables.files.delete('file-1');
unsubscribe();
```

## Attachments

Attachments are the opt-in capabilities you compose inside a `defineDocument` builder. They all ship from the package root — there are no `@epicenter/workspace/extensions/*` subpaths anymore.

```typescript
import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachSqlite,
	attachSync,
	attachTables,
	toWsUrl,
} from '@epicenter/workspace';
```

### Persistence

`attachIndexedDb(ydoc)` runs in the browser. `attachSqlite(ydoc, { filePath })` runs on Node/Bun. Both return a handle with `whenLoaded`, `whenDisposed`, and `clearLocal()`.

```typescript
import * as Y from 'yjs';
import {
	attachSqlite,
	attachTables,
	defineDocument,
	defineTable,
} from '@epicenter/workspace';
import { type } from 'arktype';

const notes = defineTable(type({ id: 'string', title: 'string', _v: '1' }));

const notesDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { notes });
	const sqlite = attachSqlite(ydoc, { filePath: '/tmp/epicenter/notes.db' });

	return {
		id,
		ydoc,
		tables,
		sqlite,
		whenReady: sqlite.whenLoaded,
		whenDisposed: sqlite.whenDisposed,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

void notesDoc;
```

### Sync

`attachSync(ydoc, config)` is the websocket transport; it already composes with `attachBroadcastChannel(ydoc)` for cross-tab sync.

```typescript
import * as Y from 'yjs';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	attachTables,
	defineDocument,
	defineTable,
	toWsUrl,
} from '@epicenter/workspace';
import { type } from 'arktype';

const tabs = defineTable(type({ id: 'string', url: 'string', _v: '1' }));

const tabsDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { tabs });
	const idb = attachIndexedDb(ydoc);
	attachBroadcastChannel(ydoc);
	const sync = attachSync(ydoc, {
		url: (docId) => toWsUrl(`https://sync.epicenter.so/rooms/${docId}`),
		waitFor: idb.whenLoaded,
	});

	return {
		id,
		ydoc,
		tables,
		idb,
		sync,
		whenReady: idb.whenLoaded,
		whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed]).then(
			() => {},
		),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

void tabsDoc;
```

Ordering is just lexical: `sync` reads `idb.whenLoaded` as `waitFor` because `idb` is defined first. No builder chain, no priority flag.

### Markdown materializer

The markdown materializer is exported from `@epicenter/workspace/document/materializer/markdown`. Compose it inside a `defineDocument` builder alongside the other attachments — it needs `tables` and `ydoc`, both of which are already in lexical scope.

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachSqlite,
	attachTables,
	defineDocument,
	defineTable,
} from '@epicenter/workspace';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';

const notes = defineTable(
	type({ id: 'string', title: 'string', body: 'string', _v: '1' }),
);

const notesDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { notes });
	const sqlite = attachSqlite(ydoc, {
		filePath: '/tmp/epicenter/notes-workspace.db',
	});
	const markdown = attachMarkdownMaterializer(
		{ ydoc, tables },
		{ dir: '/tmp/epicenter/markdown' },
	).table('notes', { filename: slugFilename('title') });

	return {
		id,
		ydoc,
		tables,
		sqlite,
		markdown,
		whenReady: sqlite.whenLoaded,
		whenDisposed: sqlite.whenDisposed,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

void notesDoc;
```

### SQLite materializer

The SQLite materializer is exported from `@epicenter/workspace/document/materializer/sqlite`. It mirrors table rows into queryable SQLite tables with optional FTS5 full-text search, using a builder pattern with `.table()` opt-in.

```typescript
import { Database } from 'bun:sqlite';
import * as Y from 'yjs';
import {
	attachSqlite,
	attachTables,
	defineDocument,
	defineTable,
} from '@epicenter/workspace';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import { type } from 'arktype';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		body: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

const blogDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { posts });
	const sqlite = attachSqlite(ydoc, { filePath: '/tmp/epicenter/blog.db' });
	const mirror = attachSqliteMaterializer(
		{ ydoc, tables },
		{ db: new Database('/tmp/epicenter/blog.db') },
	).table('posts', { fts: ['title', 'body'] });

	return {
		id,
		ydoc,
		tables,
		sqlite,
		mirror,
		whenReady: sqlite.whenLoaded,
		whenDisposed: sqlite.whenDisposed,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

// After whenReady:
// blog.mirror.search('posts', 'hello');
// blog.mirror.count('posts');
// blog.mirror.rebuild('posts');
void blogDoc;
```

The `MirrorDatabase` interface is structurally compatible with `bun:sqlite`'s `Database` and `better-sqlite3`'s `Database`—no wrapper needed. Pass your driver directly.

## Workspace Dependencies

Workspaces depend on each other the normal way: regular imports.

There is no special dependency graph inside the workspace package. If one action needs another workspace, import the other workspace client or factory and call it directly.

```typescript
import Type from 'typebox';
import { defineMutation } from '@epicenter/workspace';

declare const authWorkspace: {
	actions: {
		users: {
			getById: (input: { id: string }) => { id: string; name: string } | null;
		};
	};
};

declare const blogWorkspace: {
	tables: {
		posts: {
			set: (row: {
				id: string;
				title: string;
				authorId: string;
				_v: 1;
			}) => void;
		};
	};
};

const createPost = defineMutation({
	title: 'Create Post',
	description: 'Create a post for an existing author.',
	input: Type.Object({
		id: Type.String(),
		title: Type.String(),
		authorId: Type.String(),
	}),
	handler: ({ id, title, authorId }) => {
		const author = authWorkspace.actions.users.getById({ id: authorId });
		if (!author) return null;

		blogWorkspace.tables.posts.set({
			id,
			title,
			authorId,
			_v: 1,
		});

		return { id };
	},
});

void createPost;
```

That example uses `declare` stubs so the snippet compiles on its own, but the real pattern is just plain module composition.

## Actions

Actions are the current abstraction for developer-facing operations.

They have four important properties:

1. They are callable functions.
2. They carry metadata (`type`, `title`, `description`, `input`).
3. They close over `tables`, `kv`, and friends by normal JavaScript closure.
4. They are exposed on the bundle returned from `defineDocument`'s builder (typically as `actions: { ... }`).

### Query actions

Use `defineQuery(...)` for reads.

```typescript
import { type } from 'arktype';
import Type from 'typebox';
import * as Y from 'yjs';
import {
	attachTables,
	defineDocument,
	defineQuery,
	defineTable,
} from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

const postsDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { posts });

	const actions = {
		posts: {
			list: defineQuery({
				title: 'List Posts',
				description: 'List all posts.',
				handler: () => tables.posts.getAllValid(),
			}),

			getById: defineQuery({
				title: 'Get Post',
				description: 'Get one post by ID.',
				input: Type.Object({ id: Type.String() }),
				handler: ({ id }) => tables.posts.get(id),
			}),
		},
	};

	return {
		id,
		ydoc,
		tables,
		actions,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

const workspace = postsDoc.open('epicenter.actions.queries');

const actionType = workspace.actions.posts.list.type;
void actionType;
```

### Mutation actions

Use `defineMutation(...)` for writes or side effects.

```typescript
import { type } from 'arktype';
import Type from 'typebox';
import * as Y from 'yjs';
import {
	attachTables,
	defineDocument,
	defineMutation,
	defineTable,
	generateId,
} from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		published: 'boolean',
		_v: '1',
	}),
);

const postsDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { posts });

	const actions = {
		posts: {
			create: defineMutation({
				title: 'Create Post',
				description: 'Create a new post row.',
				input: Type.Object({ title: Type.String() }),
				handler: ({ title }) => {
					const id = generateId();
					tables.posts.set({ id, title, published: false, _v: 1 });
					return { id };
				},
			}),

			publish: defineMutation({
				title: 'Publish Post',
				description: 'Mark a post as published.',
				input: Type.Object({ id: Type.String() }),
				handler: ({ id }) => tables.posts.update(id, { published: true }),
			}),
		},
	};

	return {
		id,
		ydoc,
		tables,
		actions,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

const workspace = postsDoc.open('epicenter.actions.mutations');
void workspace;
```

### Input validation

Action inputs are TypeBox today.

That point matters because older docs implied a wider schema surface than the current implementation. `defineQuery` and `defineMutation` are typed around `typebox` `TSchema` inputs, so the safe example is:

```typescript
import Type from 'typebox';
import { defineQuery } from '@epicenter/workspace';

const searchPosts = defineQuery({
	title: 'Search Posts',
	description: 'Search posts by query string.',
	input: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
	handler: ({ query, limit }) => ({ query, limit: limit ?? 10 }),
});

void searchPosts;
```

No-input actions are just as valid:

```typescript
import { defineMutation } from '@epicenter/workspace';

const clearCache = defineMutation({
	title: 'Clear Cache',
	description: 'Clear a local cache.',
	handler: () => {
		return { cleared: true };
	},
});

void clearCache;
```

### Action properties

Every action exposes:

- `action.type` — `'query'` or `'mutation'`
- `action.title` — optional UI-facing label
- `action.description` — optional adapter-facing description
- `action.input` — optional TypeBox schema

And the action itself is callable. There is no separate `.handler` property on the returned object.

### Type guards and iteration

```typescript
import Type from 'typebox';
import {
	defineMutation,
	defineQuery,
	isAction,
	isMutation,
	isQuery,
	iterateActions,
	type Actions,
} from '@epicenter/workspace';

const actions = {
	posts: {
		list: defineQuery({ handler: () => [] as string[] }),
		create: defineMutation({
			input: Type.Object({ title: Type.String() }),
			handler: ({ title }) => ({ title }),
		}),
	},
} satisfies Actions;

for (const [action, path] of iterateActions(actions)) {
	if (isAction(action)) {
		console.log(path.join('.'), action.type);
	}
}

const listAction = actions.posts.list;
if (isQuery(listAction)) {
	console.log(listAction.type);
}

const createAction = actions.posts.create;
if (isMutation(createAction)) {
	console.log(createAction.type);
}
```

## Package entry points

All attachments and the `defineDocument` factory live at the package root. The only subpath exports today are the materializers (which pull in heavier dependencies) and a few utility surfaces.

| Import path | What it exports | Public today |
| --- | --- | --- |
| `@epicenter/workspace` | `defineDocument`, `defineTable`, `defineKv`, every `attach*` (tables, kv, indexeddb, sqlite, sync, broadcast-channel, awareness, encryption, rich-text, plain-text, timeline), action helpers, ids, dates, types | Yes |
| `@epicenter/workspace/document/materializer/markdown` | `attachMarkdownMaterializer`, serializers | Yes |
| `@epicenter/workspace/document/materializer/sqlite` | `attachSqliteMaterializer`, `generateDdl`, types | Yes |
| `@epicenter/workspace/ai` | `actionsToAiTools` (TanStack AI bindings) | Yes |
| `@epicenter/workspace/shared/crypto` | Lower-level crypto primitives for encryption attachments | Yes |

## Architecture & Lifecycle

### Document initialization lifecycle

When you call `defineDocument(builder).open(id)`, here is the actual lifecycle:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. CACHE LOOKUP                                            │
│    • keyed by id                                           │
│    • first open runs the builder; subsequent opens reuse   │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. BUILDER RUNS                                            │
│    • new Y.Doc({ guid: id })                               │
│    • attachTables / attachKv / attachAwareness             │
│    • attachIndexedDb or attachSqlite                       │
│    • attachSync (waitFor: idb.whenLoaded, …)               │
│    • builder returns the bundle                            │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. HANDLE MINTED                                           │
│    • refcount++                                            │
│    • [Symbol.dispose] bound for refcount-- on release      │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. AWAIT whenReady                                         │
│    • bundle-defined: usually idb.whenLoaded                │
│    • sync starts in background via its own waitFor         │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. LIVE HANDLE                                             │
│    • tables / kv / awareness / sync / actions              │
│    • use until [Symbol.dispose] — cache waits gcTime       │
│      before tearing down in case another caller re-opens   │
└─────────────────────────────────────────────────────────────┘
```

### `batch(fn)`

A `batch(fn)` helper on the handle groups mutations into a single Yjs
transaction. It isn't injected by the framework — you include it yourself in
the builder's return (`batch: (fn) => ydoc.transact(fn)`), which is what every
app in this repo does.

```typescript
import { type } from 'arktype';
import * as Y from 'yjs';
import {
	attachTables,
	defineDocument,
	defineTable,
} from '@epicenter/workspace';

const posts = defineTable(
	type({
		id: 'string',
		title: 'string',
		_v: '1',
	}),
);

const tags = defineTable(
	type({
		id: 'string',
		name: 'string',
		_v: '1',
	}),
);

const batchDoc = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, { posts, tags });
	return {
		id,
		ydoc,
		tables,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});

const workspace = batchDoc.open('epicenter.examples.batch');

workspace.batch(() => {
	workspace.tables.posts.set({ id: 'p1', title: 'One transaction', _v: 1 });
	workspace.tables.tags.set({ id: 't1', name: 'docs', _v: 1 });
});
```

Yjs transactions do not roll back on throw. They batch notifications; they are not SQL transactions.

### `whenReady`, `clearLocal`, and teardown

| API | What it means |
| --- | --- |
| `handle.whenReady` | User-composed readiness promise — typically `Promise.all([idb.whenLoaded, ...])` |
| `await factory.load(id)` | `open(id) + await handle.whenReady` in one step; rejects and releases the refcount if readiness fails |
| `handle.idb.clearLocal()` (or `handle.sqlite.clearLocal()`) | Wipes persisted local state for that attachment |
| `handle.dispose()` / `handle[Symbol.dispose]()` | Decrements refcount; last dispose arms the factory's `gcTime` timer |
| `factory.close(id)` | Force-closes the bundle **now**; awaits `bundle.whenDisposed` |
| `factory.closeAll()` | Force-closes every open document; awaits each `whenDisposed` |

`dispose()` preserves data. It releases the handle. To wipe persisted local
state, call `clearLocal()` on the persistence attachment (`handle.idb` or
`handle.sqlite`) directly.

### Cleanup lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│ handle.dispose() called (or using block exits)             │
│    refcount--                                              │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ refcount === 0 → arm gcTime timer                          │
│    • fresh open() during grace window cancels teardown     │
│    • gcTime: 0 tears down immediately                      │
│    • gcTime: Infinity (default) never auto-evicts          │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ bundle[Symbol.dispose]() fires                             │
│    • your builder's teardown (ydoc.destroy())              │
│    • ydoc.destroy() cascades to every attachment via       │
│      ydoc.once('destroy') — providers close, observers     │
│      stop, sockets shut down                               │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ bundle.whenDisposed settles                                │
│    • awaited by factory.close(id) / factory.closeAll()     │
└─────────────────────────────────────────────────────────────┘
```

## Client vs Server

`@epicenter/workspace` is the core client/workspace library.

The public root export does not currently ship a built-in server helper. Older docs implied otherwise; that is stale.

What the package does give you is the raw material a server adapter needs:

- `handle.actions` (whatever your builder returned)
- `iterateActions(...)`
- action metadata (`type`, `title`, `input`, `description`)
- direct access to `handle.tables`, `handle.kv`, `handle.awareness`, and per-row content factories

If you want HTTP, CLI, or MCP on top, build or import an adapter around those primitives.

## API Reference

### Schema definition

```typescript
import { defineKv, defineTable } from '@epicenter/workspace';
```

Core definition helpers:

- `defineTable(schema)`
- `defineTable(v1, v2, ...).migrate(fn)`
- `defineKv(schema, defaultValue)`

### Document creation

```typescript
import { defineDocument } from '@epicenter/workspace';
```

`defineDocument(builder)` returns a refcounted factory. `.open(id)` mints a live handle. The shape of that handle is whatever the builder returns — so `id`, `tables`, `kv`, `awareness`, `sync`, `actions`, `batch`, etc. are all things you explicitly put in the bundle.

### Typical handle properties

Everything below is a *convention* — the builder is free to expose more or less. Most epicenter apps return at least:

- `handle.id`
- `handle.ydoc`
- `handle.tables`
- `handle.kv`
- `handle.awareness`
- `handle.idb` (or `handle.sqlite`)
- `handle.sync`
- `handle.encryption` (when encrypted)
- `handle.actions`
- `handle.batch(fn)`
- `handle.whenReady` and `handle.whenDisposed`
- `handle[Symbol.dispose]()`

### Document content attachments

Per-row content is just another `attach*` call inside a per-row
`defineDocument`. Pick the attachment that matches the content shape:

- `attachPlainText(ydoc, name)` — binds a `Y.Text`. Editor gets `handle.content` as `Y.Text`.
- `attachRichText(ydoc, name)` — binds a `Y.XmlFragment` for prosemirror / tiptap / yrs-xml editors.
- `attachTimeline(ydoc)` — a polymorphic timeline that can project as text, rich text, or a sheet. Exposes `read() / write(text) / appendText(text) / asText() / asRichText() / asSheet() / currentType / observe(...) / restoreFromSnapshot(binary)`.

The factory (`defineDocument((rowId) => ...)`) caches these by `rowId`, so
multiple consumers share one Y.Doc. Use `factory.open(id) / .close(id) /
.closeAll()` to manage lifecycle.

### Actions

```typescript
import {
	defineMutation,
	defineQuery,
	isAction,
	isMutation,
	isQuery,
	iterateActions,
	type Action,
	type Actions,
	type Mutation,
	type Query,
} from '@epicenter/workspace';
```

### Table operations

```typescript
import {
	type GetResult,
	type InvalidRowResult,
	type RowResult,
	type Table,
	type UpdateResult,
	type ValidRowResult,
} from '@epicenter/workspace';
```

Public table methods:

- `parse(id, input)`
- `set(row)`
- `update(id, partial)`
- `get(id)`
- `getAll()`
- `getAllValid()`
- `getAllInvalid()`
- `filter(predicate)`
- `find(predicate)`
- `delete(id)`
- `clear()`
- `observe(callback)`
- `count()`
- `has(id)`

### KV operations

```typescript
import { type Kv, type KvChange } from '@epicenter/workspace';
```

Public KV methods:

- `get(key)`
- `set(key, value)`
- `delete(key)`
- `observe(key, callback)`
- `observeAll(callback)`

### Awareness

```typescript
import {
	type Awareness,
	type AwarenessDefinitions,
	type AwarenessState,
	type InferAwarenessValue,
} from '@epicenter/workspace';
```

Public awareness methods:

- `setLocal(state)`
- `setLocalField(key, value)`
- `getLocal()`
- `getLocalField(key)`
- `getAll()`
- `peers()`
- `observe(callback)`
- `raw`

### Introspection

```typescript
import {
	iterateActions,
	isAction,
	isMutation,
	isQuery,
} from '@epicenter/workspace';
```

`iterateActions(actions)` flattens a nested action tree into `[action, path]`
pairs. Combined with each action's `type`, `title`, `description`, and `input`
schema, that's enough to build HTTP, CLI, or MCP adapters without coupling the
core package to a transport.

### IDs and dates

```typescript
import {
	DateTimeString,
	dateTimeStringNow,
	generateGuid,
	generateId,
	type DateIsoString,
	type Guid,
	type Id,
	type TimezoneId,
} from '@epicenter/workspace';
```

### Storage keys

```typescript
import {
	KV_KEY,
	TableKey,
	type KvKey,
} from '@epicenter/workspace';
```

These matter when you are writing low-level tooling against raw Yjs structures.

### Drizzle re-exports

```typescript
import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	ne,
	not,
	or,
	sql,
} from '@epicenter/workspace';
```

These are convenience re-exports for extension code and mirror/query packages that already depend on Drizzle.

## MCP Integration

The core package does not export an MCP server. What it does export is the metadata you need to build one.

The current pieces are:

- actions with `type`, `title`, `description`, and `input`
- `iterateActions(...)` to flatten a nested action tree
- `isAction` / `isQuery` / `isMutation` type guards
- `@epicenter/workspace/ai` — `actionsToAiTools(...)` for TanStack AI tool bindings

That is enough to build adapters that expose workspace actions over HTTP, CLI, or MCP without coupling the core package to one transport.

### Setup

```typescript
import Type from 'typebox';
import {
	defineMutation,
	defineQuery,
	iterateActions,
	type Actions,
} from '@epicenter/workspace';

const actions: Actions = {
	posts: {
		list: defineQuery({
			title: 'List Posts',
			description: 'List all posts.',
			handler: () => [] as Array<{ id: string; title: string }>,
		}),

		create: defineMutation({
			title: 'Create Post',
			description: 'Create a post.',
			input: Type.Object({ title: Type.String() }),
			handler: ({ title }) => ({ id: title.toLowerCase() }),
		}),
	},
};

for (const [action, path] of iterateActions(actions)) {
	console.log({
		name: path.join('.'),
		type: action.type,
		title: action.title,
		description: action.description,
		hasInput: action.input !== undefined,
	});
}
```

That is the public adapter surface today.

## Contributing

### Local development

From the repo root:

```bash
bun install
```

Type-check the workspace package itself:

```bash
bun run typecheck
```

If you're working on the package from another local project, use Bun's normal workspace linking flow. Nothing about the current API requires a special README-only workflow.

### Running tests

From the repo root:

```bash
bun test packages/workspace
```

Or run the package test suite directly from `packages/workspace` if you prefer the local context.

### More information

Useful internal docs live nearby:

- `src/workspace/README.md` — mental model for the lower-level workspace layer
- `docs/` — package-specific architecture notes
- `specs/` — historical design docs and implementation specs

## Related Packages

If your app's data model is inherently files and folders—a code editor, a note vault with nested directories, anything where users expect `mkdir` and path resolution—[`@epicenter/filesystem`](../filesystem) builds that abstraction on top of this package. It imports `defineTable` to create a `filesTable`, wraps workspace tables and documents into POSIX-style operations (`writeFile`, `mv`, `rm`, `stat`), and plugs into the same extension system.

Most apps won't need it. If you know the shape of every record upfront, workspace tables are the right default. See [Your Data Is Probably a Table, Not a File](../../docs/articles/your-data-is-probably-a-table-not-a-file.md) for the full decision matrix.

## License

MIT
