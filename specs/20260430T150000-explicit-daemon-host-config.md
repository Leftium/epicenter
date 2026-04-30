# Explicit Daemon Host Config

**Date**: 2026-04-30
**Status**: Draft
**Author**: AI-assisted
**Branch**: codex/daemon-transport-supervisor-integration

## Overview

`epicenter.config.ts` should stop acting like a reusable client module. It should default-export an explicit list of hosted daemon workspaces.

One sentence: config hosts processes, packages export APIs.

## Motivation

### Current State

Today the loader imports `epicenter.config.ts`, scans named exports, and accepts any value that looks like a workspace:

```ts
export const fuji = openFuji({
	getToken,
	peer,
});
```

The export name becomes the daemon route prefix:

```txt
fuji.entries.create
```

This creates problems:

1. **Config pretends to be an API module**: scripts are encouraged to import config exports, even though scripts can import package factories or use `connectDaemon`.
2. **Daemon slots leak into app objects**: `actions`, `sync`, `presence`, `rpc`, and `whenReady` become reserved names on anything the loader sees.
3. **Discovery is too implicit**: named export scanning makes the loader guess what the user meant to host.
4. **Daemon factories expose too much**: Fuji daemon returns `{ ...doc, yjsLog, sync, presence, rpc, sqlite, markdown }`, even though only a few fields are daemon surface.

### Desired State

`epicenter.config.ts` is a host declaration:

```ts
import { openFuji } from '@epicenter/fuji/daemon';
import { defineEpicenterConfig } from '@epicenter/workspace/daemon';

export default defineEpicenterConfig([
	openFuji({
		peer: {
			id: 'fuji-daemon',
			name: 'Fuji Daemon',
			platform: 'node',
		},
	}),
]);
```

`openFuji()` returns a `HostedWorkspace` or `Promise<HostedWorkspace>`. It defaults to `id: 'fuji'`, so most projects do not pass an id.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Config shape | `defineEpicenterConfig(HostedWorkspaceInput[])` | No export scanning, no fake single `workspaces` key |
| Route id | `HostedWorkspace.id`, defaulted by host factory | Terse common case, override still possible |
| Fuji daemon return | `HostedWorkspace` facade only | Persistence and materializers run privately |
| Readiness | Async host construction | A hosted workspace is ready once the factory resolves. The daemon should not carry a separate `whenReady` field. |
| Script typing | `ReturnType<typeof createFujiActions>` | Scripts depend on action factories, not config exports |
| Token default | Open question | Best ergonomics imports CLI auth in daemon subpaths; cleanest boundary keeps `getToken` explicit |

## Target API

```ts
export type HostedWorkspace = {
	id: string;
	actions: Record<string, unknown>;
	sync?: SyncAttachment;
	presence?: PeerPresenceAttachment;
	rpc?: SyncRpcAttachment;
	[Symbol.dispose](): void;
};

export type HostedWorkspaceInput =
	| HostedWorkspace
	| Promise<HostedWorkspace>;

export function defineEpicenterConfig(hosts: HostedWorkspaceInput[]) {
	return Object.freeze({ hosts });
}

export function hostWorkspace(options: {
	id: string;
	actions?: Record<string, unknown>;
	sync?: SyncAttachment;
	presence?: PeerPresenceAttachment;
	rpc?: SyncRpcAttachment;
	dispose: () => void;
}): HostedWorkspace {
	return {
		id: options.id,
		actions: options.actions ?? {},
		...(options.sync && { sync: options.sync }),
		...(options.presence && { presence: options.presence }),
		...(options.rpc && { rpc: options.rpc }),
		[Symbol.dispose]: options.dispose,
	};
}
```

## Fuji Target

```ts
export type OpenFujiDaemonOptions = {
	id?: string;
	peer: PeerDescriptor;
	getToken?: () => Promise<string | null>;
	projectDir?: ProjectDir;
	clientID?: number;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

export async function openFuji({
	id = 'fuji',
	peer,
	getToken,
	projectDir = findEpicenterDir(),
	clientID = hashClientId(projectDir),
	apiUrl = EPICENTER_API_URL,
	webSocketImpl,
}: OpenFujiDaemonOptions): Promise<HostedWorkspace> {
	const doc = openFujiDoc({ clientID });
	const tokenGetter = getToken ?? defaultTokenGetter(apiUrl);

	const yjsLog = attachYjsLog(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		getToken: tokenGetter,
		webSocketImpl,
	});

	const presence = sync.attachPresence({ peer });
	const rpc = sync.attachRpc(doc.actions);

	attachSqlite(doc.ydoc, {
		filePath: sqlitePath(projectDir, doc.ydoc.guid),
	}).table(doc.tables.entries);

	attachMarkdown(doc.ydoc, {
		dir: markdownPath(projectDir, doc.ydoc.guid),
	}).table(doc.tables.entries, { filename: slugFilename('title') });

	return hostWorkspace({
		id,
		actions: doc.actions,
		sync,
		presence,
		rpc,
		dispose: () => doc[Symbol.dispose](),
	});
}
```

The key collapse:

```diff
- return { ...doc, yjsLog, sync, presence, rpc, sqlite, markdown };
+ return hostWorkspace({
+   id,
+   actions: doc.actions,
+   sync,
+   presence,
+   rpc,
+   dispose: () => doc[Symbol.dispose](),
+ });
```

## Token Default Question

There are two viable choices.

Option A: daemon subpaths own CLI token loading.

```ts
import { createSessionStore } from '@epicenter/cli';

function defaultTokenGetter(apiUrl: string) {
	const sessions = createSessionStore();
	return async () => (await sessions.load(apiUrl))?.accessToken ?? null;
}
```

This gives the best config:

```ts
export default defineEpicenterConfig([
	openFuji({ peer }),
]);
```

Option B: config passes a token getter.

```ts
const sessions = createSessionStore();

export default defineEpicenterConfig([
	openFuji({
		peer,
		getToken: async () =>
			(await sessions.load(EPICENTER_API_URL))?.accessToken ?? null,
	}),
]);
```

Recommendation: start with Option A if `./daemon` subpaths are allowed to depend on CLI auth storage. Otherwise add `cliTokenGetter()` in `@epicenter/cli` and keep `getToken` explicit.

## Loader Migration

Current loader:

```txt
import config module
scan named exports
skip default
accept workspace-shaped values
route id = export name
```

Target loader:

```txt
import config module
read default export
validate defineEpicenterConfig result
hosts = await Promise.all(config.hosts)
entries = hosts.map(host => ({ name: host.id, workspace: host }))
route id = host.id
```

Most daemon internals can stay stable because `loadConfig()` can still return `WorkspaceEntry[]`.

## Readiness Model

There is no `HostedWorkspace.whenReady`.

If a daemon workspace needs local setup before actions are safe to run, its host factory awaits that work before returning:

```ts
export async function openFuji(options): Promise<HostedWorkspace> {
	const doc = openFujiDoc(options);
	const idb = attachIndexedDb(doc.ydoc, { name: 'fuji' });
	await idb.whenLoaded;

	const sync = attachSync(doc, { ... });

	return hostWorkspace({
		id: 'fuji',
		actions: doc.actions,
		sync,
		dispose: () => doc[Symbol.dispose](),
	});
}
```

The daemon loader awaits host construction once, during config load. After that, local action dispatch does not need another generic readiness gate.

Network readiness is separate. A normal local action should not wait for `sync.whenConnected` unless the action itself needs the network. Peer calls already wait through presence and RPC resolution.

## Script Typing

Scripts should not import `epicenter.config.ts`.

```ts
import type { createFujiActions } from '@epicenter/fuji/workspace';
import { connectDaemonActions } from '@epicenter/workspace';

using fuji = await connectDaemonActions<ReturnType<typeof createFujiActions>>({
	id: 'fuji',
});
```

This suggests adding:

```ts
export async function connectDaemonActions<TActions>(options: {
	id: string;
	projectDir?: ProjectDir;
}): Promise<DaemonActions<TActions>>;
```

`connectDaemon<TWorkspace>()` can remain for compatibility, but docs should move to action-tree typing.

## Implementation Plan

### Phase 1: Host Types

- [ ] **1.1** Add `HostedWorkspace`, `hostWorkspace`, and `defineEpicenterConfig`.
- [ ] **1.2** Keep `WorkspaceEntry[]` as the internal daemon server input.
- [ ] **1.3** Add tests for duplicate `host.id` detection.
- [ ] **1.4** Remove `whenReady` from hosted workspace types and daemon dispatch.

### Phase 2: Loader

- [ ] **2.1** Teach `loadConfig()` to read default host config.
- [ ] **2.2** Await every `HostedWorkspaceInput` before building `WorkspaceEntry[]`.
- [ ] **2.3** Keep named export scanning temporarily if migration needs compatibility.
- [ ] **2.4** Update loader errors from “config export” to “hosted workspace”.

### Phase 3: Fuji

- [ ] **3.1** Change `apps/fuji/src/lib/fuji/daemon.ts` to return `HostedWorkspace`.
- [ ] **3.2** Default `id` to `'fuji'`.
- [ ] **3.3** Stop exposing `ydoc`, `tables`, `yjsLog`, `sqlite`, and `markdown` from the daemon return.
- [ ] **3.4** Make daemon setup async if any local persistence or materializer setup needs to finish before actions run.
- [ ] **3.5** Decide whether `getToken` defaults through CLI auth or remains explicit.

### Phase 4: Call Sites and Docs

- [ ] **4.1** Migrate example configs to `export default defineEpicenterConfig([...])`.
- [ ] **4.2** Replace docs that import from `epicenter.config.ts`.
- [ ] **4.3** Add `connectDaemonActions<TActions>()`.
- [ ] **4.4** Update script examples to type against `create*Actions`.

## Open Questions

1. **Should daemon subpaths import `@epicenter/cli` for default token loading?**
   - Options: import CLI auth in app daemon subpaths, require `getToken`, or add a small `cliTokenGetter()` helper.
   - Recommendation: import CLI auth in daemon subpaths if it keeps config clean and does not create package cycles.

2. **Should named export scanning remain as a compatibility bridge?**
   - Options: remove immediately, support both temporarily, or keep permanently.
   - Recommendation: support both for one migration window, but mark named export scanning as legacy.

3. **Should `HostedWorkspace.id` be overrideable?**
   - Options: require every call to pass `id`, default by app factory, or derive from config.
   - Recommendation: default by app factory. `openFuji()` should default to `'fuji'`.
