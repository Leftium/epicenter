# Explicit Daemon Host Config

**Date**: 2026-04-30
**Status**: Draft
**Author**: AI-assisted
**Branch**: codex/daemon-transport-supervisor-integration

## Overview

`epicenter.config.ts` should stop acting like a reusable client module. It should default-export an explicit record of hosted daemon workspaces.

One sentence: config names daemon hosts, packages export APIs.

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
import { findEpicenterDir } from '@epicenter/workspace/node';

const projectDir = findEpicenterDir(import.meta.dir);

export default defineEpicenterConfig({
	fuji: openFuji({ projectDir }),
});
```

The record key becomes the daemon route prefix. `openFuji()` returns a `HostedWorkspace` or `Promise<HostedWorkspace>` without carrying a route id.

## Naming Model

Three identifiers stay separate:

| Name | Example | Owner | Meaning |
| --- | --- | --- | --- |
| Route key | `fuji` | `epicenter.config.ts` | Local daemon address used by `epicenter run fuji.entries.create` |
| Y.Doc guid | `epicenter.fuji` | Fuji document factory | Durable workspace identity used by storage and sync |
| Yjs clientID | `hashClientId(projectDir)` | Fuji daemon factory | Writer identity for this process inside Yjs updates |

The route key and Y.Doc guid often look related, but they should not be the same source of truth. The Y.Doc guid is a product-level document identity. The route key is a host-level address. Collapsing them would make local deployment naming change storage and sync identity, which is the wrong coupling.

This separation is still useful when Fuji is only mounted once. It lets `openFuji()` delete `id?: string` entirely. The config owns the name, and the package owns the document.

## Self-Named Host Alternative

There is one coherent array-shaped alternative: make each hosted workspace carry an `id`, and make that `id` the same durable id as the underlying Y.Doc.

```ts
export type HostedWorkspace = {
	id: string;
	actions: Record<string, unknown>;
	sync?: SyncAttachment;
	presence?: PeerPresenceAttachment;
	rpc?: SyncRpcAttachment;
	[Symbol.dispose](): void;
};

export default defineEpicenterConfig([
	openFuji({
		projectDir,
		getToken,
		peer,
	}),
]);
```

Fuji would return:

```ts
const WORKSPACE_ID = 'epicenter.fuji';

export function openFuji(options): HostedWorkspace {
	const doc = openFujiDoc(options);

	return {
		id: WORKSPACE_ID,
		actions: doc.actions,
		sync,
		presence,
		rpc,
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
		},
	};
}
```

Then the loader can use the host id directly:

```ts
const entries = await Promise.all(
	config.hosts.map(async (hostInput) => {
		const host = await hostInput;
		return { name: host.id, workspace: host };
	}),
);
```

This works, but it changes the thesis. The route name is no longer a host-level address. It becomes the package's durable workspace id:

```txt
epicenter run epicenter.fuji.entries.create
```

If that is the product decision, the array shape is clean. The package owns its canonical id, config lists hosted packages, and there is one fewer naming surface.

The cost is coupling. Renaming the CLI route now touches the same value used for sync and local storage. If the loader maps `epicenter.fuji` back down to `fuji`, then the single source of truth is gone again. The system has an implicit route transform instead of an explicit config key.

This spec currently chooses the record shape because it treats the route as deployment naming:

```ts
export default defineEpicenterConfig({ fuji: openFuji({ projectDir }) });
```

That choice is not mainly about mounting Fuji twice. It is about keeping local addresses separate from durable document identity.

## Defaults and Overrides

The daemon factory should make the normal config short, but the defaults need to respect the identity boundaries above.

| Value | Default | Override? | Rationale |
| --- | --- | --- | --- |
| Route key | Config record key, e.g. `fuji` | Yes, by changing the record key | Local daemon address belongs to the host project |
| Y.Doc guid | Hard-coded in the app doc factory, e.g. `epicenter.fuji` | No, unless the app adds a separate product feature | Changing storage and sync identity should be deliberate |
| Yjs clientID | `hashClientId(projectDir)` | Yes, mainly tests | Stable per-project writer identity is the right default |
| Project dir | Explicit `findEpicenterDir(import.meta.dir)` in config | Yes | `epicenter up -C` means `process.cwd()` may not be the config directory |
| API URL | `EPICENTER_API_URL` | Yes | Self-hosting and tests need an override |
| WebSocket impl | Runtime default | Yes | Tests and non-standard runtimes need injection |
| Peer | App daemon default, e.g. `{ id: 'fuji-daemon', name: 'Fuji Daemon', platform: 'node' }` | Yes | Presence identity has an obvious app default, but tests and custom hosts need stable names |
| Token getter | Prefer default only if dependency boundary stays clean | Yes | The host normally runs on the same machine as `epicenter auth login`, but app daemon subpaths should not grow an accidental CLI package cycle |

The preferred config is therefore:

```ts
const projectDir = findEpicenterDir(import.meta.dir);

export default defineEpicenterConfig({
	fuji: openFuji({ projectDir }),
});
```

And the fully explicit form remains available:

```ts
export default defineEpicenterConfig({
	fuji: openFuji({
		projectDir,
		getToken,
		peer: {
			id: 'custom-fuji-daemon',
			name: 'Custom Fuji Daemon',
			platform: 'node',
		},
		apiUrl,
		webSocketImpl,
	}),
});
```

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Config shape | `defineEpicenterConfig(Record<string, HostedWorkspaceInput>)` | No export scanning, no fake single `workspaces` key, and route names live at the host boundary |
| Route id | Config record key | The project names what it hosts. Package daemon factories do not own deployment names. |
| Fuji daemon return | `HostedWorkspace` facade only | Persistence and materializers run privately |
| Readiness | Async host construction | A hosted workspace is ready once the factory resolves. The daemon should not carry a separate `whenReady` field. |
| Script typing | `ReturnType<typeof createFujiActions>` | Scripts depend on action factories, not config exports |
| Peer default | App daemon factory defaults `peer` | The normal daemon identity is obvious and overrideable |
| Token default | Conditional default | Add it only if the token helper can live in a small host-runtime module without an app to CLI cycle |

## Target API

```ts
export type HostedWorkspace = {
	actions: Record<string, unknown>;
	sync?: SyncAttachment;
	presence?: PeerPresenceAttachment;
	rpc?: SyncRpcAttachment;
	[Symbol.dispose](): void;
};

export type HostedWorkspaceInput =
	| HostedWorkspace
	| Promise<HostedWorkspace>;

export type EpicenterConfig = {
	hosts: Record<string, HostedWorkspaceInput>;
};

export function defineEpicenterConfig(
	hosts: Record<string, HostedWorkspaceInput>,
): EpicenterConfig {
	return Object.freeze({ hosts: Object.freeze({ ...hosts }) });
}
```

## Final Vision

The end-state call sites should read like this.

Project config hosts daemon workspaces:

```ts
// epicenter.config.ts
import { openFuji } from '@epicenter/fuji/daemon';
import { defineEpicenterConfig } from '@epicenter/workspace/daemon';
import { findEpicenterDir } from '@epicenter/workspace/node';

const projectDir = findEpicenterDir(import.meta.dir);

export default defineEpicenterConfig({
	fuji: openFuji({ projectDir }),
});
```

Fuji's daemon subpath returns only the host surface:

```ts
// @epicenter/fuji/daemon
export async function openFuji({
	projectDir,
	peer = defaultFujiDaemonPeer(),
	getToken = defaultTokenGetter(EPICENTER_API_URL),
	clientID = hashClientId(projectDir),
	apiUrl = EPICENTER_API_URL,
	webSocketImpl,
}: OpenFujiDaemonOptions): Promise<HostedWorkspace> {
	const doc = openFujiDoc({ clientID });

	attachYjsLog(doc.ydoc, {
		filePath: yjsPath(projectDir, doc.ydoc.guid),
	});

	const sync = attachSync(doc, {
		url: toWsUrl(`${apiUrl}/workspaces/${doc.ydoc.guid}`),
		getToken,
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

	return {
		actions: doc.actions,
		sync,
		presence,
		rpc,
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
		},
	} satisfies HostedWorkspace;
}
```

Scripts type against action factories, not config exports:

```ts
import type { createFujiActions } from '@epicenter/fuji/workspace';
import { connectDaemonActions } from '@epicenter/workspace';

using fuji = await connectDaemonActions<ReturnType<typeof createFujiActions>>({
	id: 'fuji',
});

await fuji.entries.create({ title: 'Hello' });
```

The loader sees one explicit host record:

```ts
const config = module.default;
const entries = await Promise.all(
	Object.entries(config.hosts).map(async ([name, input]) => ({
		name,
		workspace: await input,
	})),
);
```

In this model, `epicenter.config.ts` is not a reusable client module. It is the project-local daemon host manifest.

## Fuji Target

```ts
export type OpenFujiDaemonOptions = {
	peer?: PeerDescriptor;
	getToken?: () => Promise<string | null>;
	projectDir: ProjectDir;
	clientID?: number;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

export async function openFuji({
	peer = defaultFujiDaemonPeer(),
	getToken,
	projectDir,
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

	return {
		actions: doc.actions,
		sync,
		presence,
		rpc,
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
		},
	} satisfies HostedWorkspace;
}
```

The key collapse:

```diff
- return { ...doc, yjsLog, sync, presence, rpc, sqlite, markdown };
+ return {
+   actions: doc.actions,
+   sync,
+   presence,
+   rpc,
+   [Symbol.dispose]() {
+     doc[Symbol.dispose]();
+   },
+ } satisfies HostedWorkspace;
```

## Token Default

The host normally runs on the same machine as `epicenter auth login`, so a default token getter is attractive:

```ts
export default defineEpicenterConfig({
	fuji: openFuji({ projectDir }),
});
```

The default should not make app daemon subpaths import the whole CLI package if that creates a package cycle. Prefer one of these shapes:

1. Move the session token reader into a small host-runtime module that app daemon subpaths can depend on.
2. Add a narrow `@epicenter/cli/auth` or `@epicenter/cli/session` subpath that has no command or loader imports.
3. Keep `getToken` explicit until the repeated boilerplate is painful enough to justify the extraction.

The fallback explicit form is:

```ts
const sessions = createSessionStore();
const getToken = async () =>
	(await sessions.load(EPICENTER_API_URL))?.accessToken ?? null;

export default defineEpicenterConfig({
	fuji: openFuji({ projectDir, getToken }),
});
```

Recommendation: default `getToken` if it can be implemented through a narrow auth/session runtime dependency. Do not make `@epicenter/fuji/daemon` import the full CLI root.

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
hosts = Object.entries(config.hosts)
entries = await Promise.all(
  hosts.map(async ([name, host]) => ({ name, workspace: await host }))
)
route id = record key
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

	return {
		actions: doc.actions,
		sync,
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
		},
	} satisfies HostedWorkspace;
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

- [ ] **1.1** Add `HostedWorkspace` and `defineEpicenterConfig`.
- [ ] **1.2** Keep `WorkspaceEntry[]` as the internal daemon server input.
- [ ] **1.3** Add tests for invalid route keys and non-workspace host values.
- [ ] **1.4** Remove `whenReady` from hosted workspace types and daemon dispatch.

### Phase 2: Loader

- [ ] **2.1** Teach `loadConfig()` to read default host config.
- [ ] **2.2** Await every `HostedWorkspaceInput` before building `WorkspaceEntry[]`.
- [ ] **2.3** Keep named export scanning temporarily if migration needs compatibility.
- [ ] **2.4** Update loader errors from “config export” to “hosted workspace”.

### Phase 3: Fuji

- [ ] **3.1** Change `apps/fuji/src/lib/fuji/daemon.ts` to return `HostedWorkspace`.
- [ ] **3.2** Remove `id` from `OpenFujiDaemonOptions`.
- [ ] **3.3** Stop exposing `ydoc`, `tables`, `yjsLog`, `sqlite`, and `markdown` from the daemon return.
- [ ] **3.4** Make daemon setup async if any local persistence or materializer setup needs to finish before actions run.
- [ ] **3.5** Keep `projectDir` explicit in daemon options.
- [ ] **3.6** Default `peer` in app daemon factories and keep it overrideable.
- [ ] **3.7** Decide whether `getToken` can default through a narrow auth/session runtime dependency.

### Phase 4: Call Sites and Docs

- [ ] **4.1** Migrate example configs to `export default defineEpicenterConfig({ ... })`.
- [ ] **4.2** Replace docs that import from `epicenter.config.ts`.
- [ ] **4.3** Add `connectDaemonActions<TActions>()`.
- [ ] **4.4** Update script examples to type against `create*Actions`.

## Open Questions

1. **Where should the default token getter live?**
   - Options: app daemon subpaths import a narrow CLI auth/session subpath, session storage moves to a smaller host-runtime package, or config passes `getToken`.
   - Recommendation: default `getToken` only if the dependency stays narrow and cycle-free. Otherwise keep the explicit config closure.

2. **Should named export scanning remain as a compatibility bridge?**
   - Options: remove immediately, support both temporarily, or keep permanently.
   - Recommendation: support both for one migration window, but mark named export scanning as legacy.

3. **Should `defineEpicenterConfig()` accept a raw record without a wrapper?**
   - Options: require `defineEpicenterConfig({ ... })`, accept `export default { ... }`, or support both.
   - Recommendation: require the helper first. It gives the loader a reliable shape and gives TypeScript a place to validate host values.

4. **Should routes come from config keys or hosted workspace ids?**
   - Options: record keys name routes, or hosted workspaces carry `id` and config is an array.
   - Recommendation: keep record keys unless the product explicitly wants CLI routes to equal durable document ids.
