# Epicenter architecture
Epicenter is one composition story. The core packages define the local-first model, the middle layer turns that model into app-shaped tools, and the apps decide which pieces to compose.
The lifecycle is define, create, extend, sync. That order matters because Epicenter keeps schema definition pure, pushes side effects to the edge, and lets each app choose how much runtime machinery it needs.
This is the five-minute map. It explains how the packages interlock without redoing the full `@epicenter/workspace` README.

## The stack in one picture
The dependency shape runs bottom to top. Apps depend on middleware; middleware depends on the core; the core stays small and reusable.

```text
+----------------------------------------------------------------------------+
| APPS                                                                       |
|                                                                            |
| opensidian   whispering   tab-manager   fuji   zhongwen                    |
| honeycrisp   dashboard    api           landing                            |
+----------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------+
| MIDDLEWARE                                                                 |
|                                                                            |
| @epicenter/svelte      (packages/svelte-utils)                             |
| @epicenter/filesystem                                                      |
| @epicenter/skills                                                          |
| @epicenter/workspace/ai                                                    |
+----------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------+
| CORE                                                                       |
|                                                                            |
| @epicenter/workspace   @epicenter/sync   @epicenter/constants   @epicenter/ui |
+----------------------------------------------------------------------------+
```
`@epicenter/workspace` is the center of gravity. It defines the schema layer, creates the live Yjs-backed client, owns the extension lifecycle, and exposes tables, KV, documents, presence, and actions.
`@epicenter/sync` is the wire format, not the app model. It exports protocol primitives like `encodeSyncStep1`, `encodeSyncUpdate`, `decodeSyncMessage` so server and client can speak the same binary language without duplicating protocol logic.
`@epicenter/constants` is the routing glue. It gives apps one source of truth for URLs, ports, and versioning so sync endpoints, auth URLs, and cross-app links do not drift.
`@epicenter/ui` is the shared presentation layer. It knows Svelte components, not Yjs semantics.
The middleware layer is where workspace data starts feeling like an application. `@epicenter/svelte` turns workspace helpers into reactive Svelte state, `@epicenter/filesystem` turns workspace rows and documents into a POSIX-style filesystem, `@epicenter/skills` proves that whole workspaces can be packaged and embedded as data products, and `@epicenter/workspace/ai` bridges workspace actions into LLM-callable tools.
The apps are thin by comparison. Each app picks a definition, creates a client, installs the extensions it needs, and layers UI or transport concerns on top.

## The lifecycle: define, create, extend, sync
The four verbs are the architecture. If you remember nothing else, remember that Epicenter keeps those stages separate on purpose.

### 1. Define is pure
`defineTable` and `defineKv` are pure declarations. They do not create a `Y.Doc`, open IndexedDB, start a WebSocket, or touch the network.

```ts
import { type } from 'arktype';
import {
	defineKv,
	defineTable,
} from '@epicenter/workspace';

const files = defineTable(
	type({
		id: 'string',
		name: 'string',
		_v: '1',
	}),
);

const themeMode = defineKv(type("'light' | 'dark' | 'system'"), 'system');
```

That purity is what makes cross-package reuse work. The same table and KV declarations can be imported by an app, a CLI tool, a migration utility, a test, or another package without dragging runtime side effects along for the ride.

### 2. `createWorkspace` is where the live bundle appears
`createWorkspace({ id, tables, kv })` is the boundary where static meaning turns into live state. It allocates the `Y.Doc`, derives the encryption keyring (if a `keyring` is passed) once at construction, registers and activates every typed table and KV slot atomically, and returns a typed bundle. The bundle owns the Y.Doc lifecycle: `[Symbol.dispose]()` calls `ydoc.destroy()`, and cascade disposal tears every attached store down.

```ts
import { createWorkspace } from '@epicenter/workspace';

const workspace = createWorkspace({
	id: 'example.app',
	tables: { files },
	kv: { themeMode },
});

workspace.tables.files.set({ id: 'readme.md', name: 'README.md', _v: 1 });
```

The split is conceptual, not cosmetic. Definitions describe what data means; `createWorkspace` is the runtime that can actually hold and mutate that data.

### 3. Extend means adding more `attach*` calls
There is no plugin chain. Persistence, indexing, and materializers all mount through `attach*` functions; the workspace's network surface (sync + presence + dispatch) mounts through the `openCollaboration` primitive. You compose them inline against `workspace.ydoc` after `createWorkspace`.

The example below syncs a cloud document. A cloud doc is owned by the authenticated `owner` and addressed by its own `ydoc.guid`, so the client builds the URL with `roomWsUrl({ baseURL, owner, guid: ydoc.guid, installationId })`; the server resolves it to the DO name `users/${userId}/rooms/${room}` (personal) or `rooms/${room}` (team). There is no workspace lookup and no membership check: ownership is identity.

```ts
import {
	attachIndexedDb,
	createWorkspace,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';

const workspace = createWorkspace({
	id: 'example.app',
	tables: { files },
	kv: { themeMode },
});
const idb = attachIndexedDb(workspace.ydoc);
const collaboration = openCollaboration(workspace.ydoc, {
	url: roomWsUrl({
		baseURL: auth.baseURL,
		owner,
		guid: workspace.ydoc.guid,
		installationId,
	}),
	openWebSocket: auth.openWebSocket,
	onReconnectSignal: auth.onStateChange,
	waitFor: idb.whenLoaded,
	actions: {},
});
```

Ordering is lexical. `openCollaboration` reads `idb.whenLoaded` as `waitFor` because `idb` is already in scope. Later attachments see earlier ones directly. There is no context object to route through.

For extensions that need their own Y.Doc per row (file content, note bodies), use sub-doc primitives like `attachRichText(childYdoc)` or `attachTimeline(childYdoc)` against a raw `Y.Doc`, then mount `openCollaboration` on it with an empty `actions` registry. Inbound dispatch frames reply `ActionNotFound`; the byte transport and presence channel are identical.

### 4. Collaboration is just another attachment, but it changes the topology
`openCollaboration` does not own the document. It attaches to a Y.Doc that already exists and starts moving CRDT updates between peers. The relay publishes presence over its own channel; cross-device dispatch rides a plain HTTP POST. The `waitFor: idb.whenLoaded` option ensures local state is replayed first, so the initial handshake is a delta, not a full document transfer.

Local state exists first, then optional durability, then optional network coordination.

## The async boundary is `whenReady`
The builder runs synchronously, but attachments load asynchronously. Conventionally the bundle exposes a `whenReady` promise, usually `idb.whenLoaded`, so callers can await full local availability:

```ts
// Reactive callers (Svelte $effect, {#await}) construct and gate on whenReady.
const workspace = createWorkspace({ id: 'example.app', tables, kv });
const idb = attachIndexedDb(workspace.ydoc);
await idb.whenLoaded;
```

That promise is the line between construction and full availability. Construct synchronously, await whichever attachment exposes the relevant readiness signal.

## Disposal cascades from `ydoc.destroy()`
Teardown runs through Yjs itself. Every async `attach*` function registers `ydoc.once('destroy')` internally, so when the workspace bundle's `[Symbol.dispose]()` calls `ydoc.destroy()`, every attachment starts teardown in parallel. Attachments with genuine async cleanup expose `whenDisposed` for the callers that need a barrier:

```ts
workspace[Symbol.dispose]();
await workspace.idb.whenDisposed;
await workspace.collaboration.whenDisposed;
```

Browser bundles expose `wipe()` for explicit local cleanup such as "Forget this device." Sign-out does not call it. The wipe sequence disposes the live bundle, awaits the async attachments needed to unblock storage deletion, then deletes persisted local state. The refcounted cache still calls `[Symbol.dispose]()` on the last release after the `gcTime` grace period; it does not aggregate an async disposal barrier.

## Write and read flow
Writes always hit Yjs first. Everything else reacts to that state instead of becoming a competing source of truth.

```text
WRITE FLOW

app code / action / UI event
            |
            v
   workspace.tables / kv / documents
            |
            v
          Y.Doc
            |
   +--------+---------------+---------------+
   v        v               v               v
persistence sync       sqlite index   markdown/file views
IndexedDB   WebSocket  or search      or other materializers
SQLite      relay      extensions     built from workspace data
```

Reads split by purpose. Simple reads stay in the workspace client, while derived reads can come from extension exports built on top of that same client state.

```text
READ FLOW

          Y.Doc
            |
   +--------+---------------+-------------------------+
   v        v               v                         v
tables      kv             documents                 extensions
typed rows  settings       per-row content docs      indexes/materializers
   |         |               |                         |
   +---------+---------------+-------------------------+
                             |
                             v
                          app UI
```

That model is why Epicenter can mix SQL-like lookup, filesystem semantics, and collaborative document editing without splitting the truth into three different stores. They are three views over one CRDT core.

## Opensidian is the best concrete example
Opensidian composes nearly every layer inline in a per-app browser opener. Its schema starts with `filesTable` from `@epicenter/filesystem`, adds chat tables locally, and constructs the workspace with `createWorkspace`.

```ts
import { filesTable } from '@epicenter/filesystem';
import {
	attachIndexedDb,
	createWorkspace,
	defineActions,
	defineQuery,
	defineTable,
	openCollaboration,
	roomWsUrl,
} from '@epicenter/workspace';

const conversationsTable = defineTable(/* ... */);
const chatMessagesTable = defineTable(/* ... */);
const toolTrustTable = defineTable(/* ... */);

export function openOpensidianBrowser() {
	const workspace = createWorkspace({
		id: 'opensidian',
		tables: {
			files: filesTable,
			conversations: conversationsTable,
			chatMessages: chatMessagesTable,
			toolTrust: toolTrustTable,
		},
		kv: {},
	});
	const idb = attachIndexedDb(workspace.ydoc);
	const sqliteIndex = createSqliteIndex({ ydoc: workspace.ydoc, tables: workspace.tables });
	const actions = defineActions({
		files_search: defineQuery({
			handler: async ({ query }) => sqliteIndex.search(query),
		}),
	});
	const collaboration = openCollaboration(workspace.ydoc, {
		url: roomWsUrl({
			baseURL: auth.baseURL,
			owner,
			guid: workspace.ydoc.guid,
			installationId,
		}),
		openWebSocket: auth.openWebSocket,
		onReconnectSignal: auth.onStateChange,
		waitFor: idb.whenLoaded,
		actions,
	});
	return { ...workspace, idb, collaboration, sqliteIndex, actions };
}
```

That bundle then feeds other middleware packages. `attachYjsFileSystem(workspace.tables.files, workspace.filesContent)` turns the files table plus content docs into a real virtual filesystem; `actionsToAiTools(workspace)` from `@epicenter/workspace/ai` turns workspace actions into chat tools; per-row content docs use sub-doc primitives like `attachRichText`; `createCookieAuth()` or `createBearerAuth()` from `@epicenter/auth-svelte` coordinates identity, fetch, and WebSocket auth while `@epicenter/auth` provides the signed-in identity used by lazy encryption key callbacks.

```text
createWorkspace({ id: 'opensidian', tables, kv })
    |
    +-- workspace.ydoc, workspace.tables, workspace.kv
    +-- attachIndexedDb(workspace.ydoc)
    +-- createSqliteIndex(...)
    +-- openCollaboration(workspace.ydoc, { url, openWebSocket, onReconnectSignal, waitFor: idb.whenLoaded, actions })
    |
    +-- attachYjsFileSystem(...)              -> editor + terminal + file tree
    +-- actionsToAiTools(...).tools           -> local AI tool execution
    +-- actionsToAiTools(...).definitions     -> wire payload for chat requests
    +-- attachRichText(childYdoc) per file    -> per-row content docs
    +-- fromTable / fromKv / auth             -> reactive Svelte app state
```

That is the whole monorepo in miniature. The app is mostly composition code because the packages under it already agree on the same runtime shape.

## The sync philosophy is dumb server, smart client
The server is a relay, not the authority. Clients own schema meaning, table helpers, migrations, encryption activation, action handlers, and most of the user-facing behavior.

`@epicenter/sync` reflects that philosophy in its API. It exports protocol encode/decode functions, while `openCollaboration` plugs those primitives into a live workspace that already knows how to read and write its own data.

That means the server does not need to understand your tables. It forwards Yjs sync messages. Presence is server state: the relay owns the `connections` map and pushes a `presence` text frame, the full list of connected installs, on every change. Cross-device dispatch is a plain HTTP POST the relay routes to the recipient's socket. Neither rides the CRDT, and neither needs the server to decode your data.

This is what "smart client" means here. The client can boot locally, read persisted state, apply encryption keys, expose actions, open document timelines, and keep working offline before the network helps at all.

This is what "dumb server" means here. The server helps peers find each other and exchange updates, but it is not where the data model becomes valid or meaningful.

## The shortest accurate mental model
Epicenter defines data first. `@epicenter/workspace` gives that data a live Yjs document via `createWorkspace({ id, tables, kv })`, `attach*` primitives add durability and transport, middleware packages reinterpret the same bundle for files, skills, Svelte state, and AI tools, and the apps compose those layers into actual products.

Everything after that is detail. Useful detail, but still detail.
