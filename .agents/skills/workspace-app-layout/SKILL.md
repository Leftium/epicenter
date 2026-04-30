---
name: workspace-app-layout
description: How each app under apps/* lays out its workspace package, pure environment factories, daemon/script bindings, and app singleton. Use when creating workspace-backed apps, adding daemon or script consumers, or deciding where browser-only, Bun-only, or platform-specific imports belong.
metadata:
  author: epicenter
  version: '3.0'
---

# Workspace App Layout

Workspace apps split construction from runtime side effects.

```txt
apps/<app>/src/lib/
|- client.ts              optional singleton when the app has been lifted
`- <app>/
    |- index.ts           iso doc factory, or core.ts after a larger relocation
    |- browser.ts         browser factory
    |- daemon.ts          long-lived daemon factory
    |- script.ts          one-shot script factory
    `- integration.test.ts
```

Current apps may still keep `client.ts` inside `src/lib/<app>/`. When changing
only daemon transport, do not relocate the singleton unless the requested work
needs that review churn. The important boundary is that `client.ts` is the only
singleton with side effects, while `index.ts`, `browser.ts`, `daemon.ts`, and
`script.ts` stay pure construction surfaces.

## Layers

| File | Job | Imports | Returns |
| --- | --- | --- | --- |
| `index.ts` or `core.ts` | Isomorphic doc factory | Workspace core, schemas, pure action factories | `ydoc`, tables, kv, encryption, actions, batch, dispose |
| `browser.ts` | Browser factory | Iso factory plus IndexedDB, BroadcastChannel, sync, browser caches | Doc bundle plus browser resources |
| `daemon.ts` | Long-lived daemon factory | Iso factory plus `attachYjsLog`, `attachSync`, materializers | Doc bundle plus writer persistence and sync |
| `script.ts` | One-shot script factory | Iso factory plus `attachYjsLogReader`, `attachSync` | Doc bundle plus readonly warm hydrate and sync |
| `client.ts` | App singleton | One env factory plus auth/session lifecycle | `auth` and the running app singleton |

## Iso Factory

The iso factory accepts an optional `clientID` so daemon and script peers can
use stable Yjs identities.

```ts
import { attachEncryption } from '@epicenter/workspace';
import * as Y from 'yjs';
import { createFujiActions, fujiTables } from '../workspace.js';

export function openFuji({ clientID }: { clientID?: number } = {}) {
	const ydoc = new Y.Doc({ guid: 'epicenter.fuji', gc: false });
	if (clientID !== undefined) ydoc.clientID = clientID;
	const encryption = attachEncryption(ydoc);
	const tables = encryption.attachTables(ydoc, fujiTables);
	const kv = encryption.attachKv(ydoc, {});
	const actions = createFujiActions(tables);
	return {
		ydoc,
		tables,
		kv,
		encryption,
		actions,
		batch: (fn: () => void) => ydoc.transact(fn),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
```

Rules:

- Keep the iso factory free of `node:*`, `bun:*`, `chrome.*`, Tauri APIs,
  `y-indexeddb`, `BroadcastChannel`, and runtime singletons.
- Use relative imports for schemas when daemon or script files will import the
  factory outside Vite alias resolution.
- Put pure actions in the iso factory when they depend only on tables.
- Keep env-bound actions in the env factory when they need filesystem, SQLite,
  shell, browser persistence, or other runtime state. Opensidian actions stay
  extracted in `actions.ts`.

## Browser Factory

Browser factories hydrate local IndexedDB first and then attach sync with the
current public remote-action API.

```ts
export function openFuji({
	auth,
	device,
}: {
	auth: AuthClient;
	device: DeviceDescriptor;
}) {
	const doc = openFujiDoc();
	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);
	const sync = attachSync(doc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		device,
		getToken: () => auth.getToken(),
	});
	return { ...doc, idb, sync, whenReady: idb.whenLoaded };
}
```

Do not restore `sync.peer()` or `describePeer()`. Remote calls use
`createRemoteActions`; manifest fetches use `describeRemoteActions`.

## Daemon Factory

Daemon factories own the writer side of local persistence.

```ts
export function openFuji({
	getToken,
	device,
	projectDir = findEpicenterDir(),
	clientID = hashClientId(projectDir),
	apiUrl = EPICENTER_API_URL,
	webSocketImpl,
}: {
	getToken: () => Promise<string | null>;
	device: DeviceDescriptor;
	projectDir?: ProjectDir;
	clientID?: number;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
}) {
	const doc = openFujiDoc({ clientID });
	const persistence = attachYjsLog(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		device,
		getToken,
		webSocketImpl,
	});
	return { ...doc, persistence, sync };
}
```

Defaults:

- `projectDir = findEpicenterDir()`
- `clientID = hashClientId(projectDir)`
- `apiUrl = EPICENTER_API_URL`
- `webSocketImpl` is injectable for tests

The public lifecycle command is `epicenter up`. Do not document daemon
factories as `epicenter serve` consumers.

## Script Factory

Script factories read the daemon's local Yjs log and write through sync.

```ts
export function openFuji({
	getToken,
	projectDir = findEpicenterDir(),
	clientID = hashClientId(Bun.main),
	apiUrl = EPICENTER_API_URL,
	webSocketImpl,
}: {
	getToken: () => Promise<string | null>;
	projectDir?: ProjectDir;
	clientID?: number;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
}) {
	const doc = openFujiDoc({ clientID });
	const persistence = attachYjsLogReader(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		getToken,
		webSocketImpl,
	});
	return { ...doc, persistence, sync };
}
```

Defaults:

- `projectDir = findEpicenterDir()`
- `clientID = hashClientId(Bun.main)`
- `apiUrl = EPICENTER_API_URL`
- `webSocketImpl` is injectable for tests

## Package Exports

Apps that expose daemon and script factories should export them explicitly.

```json
{
	"exports": {
		"./workspace": "./src/lib/workspace.ts",
		"./openFuji": "./src/lib/fuji/index.ts",
		"./browser": "./src/lib/fuji/browser.ts",
		"./daemon": "./src/lib/fuji/daemon.ts",
		"./script": "./src/lib/fuji/script.ts"
	}
}
```

Do not export a running `client.ts` singleton from package exports.

## Tests

Every daemon/script pair should have a handoff test:

```txt
daemon opens projectDir
daemon writes rows
daemon disposes and closes writer persistence
script opens the same projectDir
script observes rows from attachYjsLogReader replay
```

Pass `NoopWebSocket` through `webSocketImpl` so the test never dials a real
relay.

## Anti-Patterns

- Putting auth, `createPersistedState`, `onSessionChange`, or HMR disposal in
  `browser.ts`, `daemon.ts`, or `script.ts`.
- Importing `daemon.ts` from browser code.
- Restoring `serve` as the public lifecycle command.
- Restoring `sync.peer()` or `describePeer()` as the primary remote action API.
- Inlining Opensidian actions back into `browser.ts`.
- Relocating `client.ts` during a daemon-only change without a review reason.
