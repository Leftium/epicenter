# YJS Persistence Guide

> **Historical note.** This guide used to describe a "provider pattern"
> (`setupPersistence`, `@epicenter/workspace/providers/*`, `text()` / `ytext()`
> column builders) that no longer exists in this codebase.
>
> Persistence today is an *attachment*, not a provider — you call
> `attachIndexedDb(ydoc)` in the browser or `attachSqlite(ydoc, { filePath })`
> on Node/Bun, both inside a `defineDocument(builder)` closure. See
> [`packages/workspace/README.md`](../../packages/workspace/README.md) for the
> Quick Start and [`packages/workspace/SYNC_ARCHITECTURE.md`](../../packages/workspace/SYNC_ARCHITECTURE.md)
> for multi-device sync.

## What is YJS?

YJS is a **CRDT (Conflict-free Replicated Data Type)** library. In Epicenter, YJS is the source of truth for all your data. Every workspace is a `Y.Doc`. Tables, KV entries, and document content are typed helpers layered over YJS shared types.

## Current model

Each app composes its workspace in a single builder:

```typescript
import {
	attachIndexedDb,
	attachSync,
	attachTables,
	defineDocument,
	toWsUrl,
} from '@epicenter/workspace';
import * as Y from 'yjs';

const app = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, appTables);
	const idb = attachIndexedDb(ydoc);                 // local persistence
	const sync = attachSync(ydoc, {                    // network sync
		url: (docId) => toWsUrl(`${serverUrl}/workspaces/${docId}`),
		waitFor: idb.whenLoaded,                         // delta-only on reconnect
	});

	return {
		id,
		ydoc,
		tables,
		idb,
		sync,
		whenReady: idb.whenLoaded,
		whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed]).then(() => {}),
		[Symbol.dispose]() { ydoc.destroy(); },
	};
});

export const workspace = app.open('epicenter.myapp');
```

Offline and sync behavior:

1. Writes go through the typed helpers into the `Y.Doc`.
2. `attachIndexedDb` (or `attachSqlite`) mirrors the Y.Doc to local storage.
3. `attachSync` waits for `idb.whenLoaded` before opening the WebSocket, so the first remote exchange is a CRDT delta against an already-populated local state — not a full document transfer.
4. When offline, writes accumulate in IndexedDB/SQLite; when back online, Yjs replays them against whatever peers did in the meantime. CRDT merge rules guarantee convergence.

For the server-side (Elysia) equivalent of accepting sync connections, see the `createSyncPlugin` helper in `@epicenter/server-remote-cloudflare` or the `apps/api/` hub.
