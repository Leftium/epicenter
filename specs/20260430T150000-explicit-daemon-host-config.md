# Explicit Daemon Host Config

**Date**: 2026-04-30
**Status**: Draft
**Author**: AI-assisted
**Branch**: codex/daemon-transport-supervisor-integration

## Overview

`epicenter.config.ts` should stop acting like a reusable client module. It should default-export an explicit list of hosted daemon workspaces.

One sentence: config hosts app-provided daemon workspaces, packages export APIs.

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
const getToken = async () =>
	(await sessions.load(EPICENTER_API_URL))?.accessToken ?? null;

export default defineEpicenterConfig([
	openFuji({ projectDir, getToken }),
]);
```

`openFuji()` returns a `HostedWorkspace` or `Promise<HostedWorkspace>` with a default daemon route of `fuji`.

Scripts import app-specific daemon action helpers instead of importing config route constants:

```ts
// scripts/create-entry.ts
import { openFujiDaemonActions } from '@epicenter/fuji/daemon';

const fuji = await openFujiDaemonActions();
```

## Naming Model

Three identifiers stay separate:

| Name | Example | Owner | Meaning |
| --- | --- | --- | --- |
| Route key | `fuji` | App daemon subpath | Local daemon address used by `epicenter run fuji.entries.create` |
| Y.Doc guid | `epicenter.fuji` | Fuji document factory | Durable workspace identity used by storage and sync |
| Yjs clientID | `hashClientId(projectDir)` | Fuji daemon factory | Writer identity for this process inside Yjs updates |

The route key and Y.Doc guid often look related, but they should not be the same source of truth. The Y.Doc guid is a product-level document identity. The route key is a host-level address. Collapsing them would make local deployment naming change storage and sync identity, which is the wrong coupling.

This separation is still useful when Fuji is only mounted once. `openFuji()` owns the default route, and the package owns the document identity. The route is a local host address, not the durable sync or storage id.

## Record-Key Alternative

There is one coherent record-shaped alternative: make config keys own route names.

```ts
export default defineEpicenterConfig({
	fuji: openFuji({ projectDir, getToken }),
});
```

Then scripts need a route string. To avoid drift, config can export constants:

```ts
export const routes = {
	fuji: 'fuji',
} as const;

export default defineEpicenterConfig({
	[routes.fuji]: openFuji({ projectDir, getToken }),
});
```

This avoids putting a route on the hosted workspace, but it reintroduces config imports in scripts:

```ts
import { routes } from '../epicenter.config';

const fuji = await connectDaemonActions<FujiActions>({
	route: routes.fuji,
});
```

This spec chooses the array shape because app daemon subpaths can provide the default route and the typed connector:

```ts
export default defineEpicenterConfig([
	openFuji({ projectDir, getToken }),
]);
```

If a project intentionally mounts Fuji under a custom route, the app daemon factory can still accept a route override.

The important consequence is that `epicenter.config.ts` no longer owns the normal route string. The app daemon subpath owns it:

```txt
@epicenter/fuji/daemon
  FUJI_DAEMON_ROUTE = "fuji"
  openFuji()              -> HostedWorkspace { route: "fuji", actions, ... }
  openFujiDaemonActions() -> connectDaemonActions({ route: "fuji" })
```

That removes the common drift case. The host and the script helper share one package-level default. `epicenter.config.ts` only composes hosts.

Custom routes stay possible, but they become an explicit local deployment choice:

```ts
export default defineEpicenterConfig([
	openFuji({ route: 'blog', projectDir }),
]);

const blog = await openFujiDaemonActions({
	route: 'blog',
});
```

This does require repeating the override at the custom script call site. That repetition is acceptable because the common path has no repetition, and the custom path is naming a local mount point rather than changing Fuji's product identity.

## Defaults and Overrides

The daemon factory should make the normal config short, but the defaults need to respect the identity boundaries above.

| Value | Default | Override? | Rationale |
| --- | --- | --- | --- |
| Route key | App daemon constant, e.g. `FUJI_DAEMON_ROUTE = 'fuji'` | Yes, through `openFuji({ route })` | Normal route is app-owned and shared by config and app-specific script helpers |
| Y.Doc guid | Hard-coded in the app doc factory, e.g. `epicenter.fuji` | No, unless the app adds a separate product feature | Changing storage and sync identity should be deliberate |
| Yjs clientID | `hashClientId(projectDir)` | Yes, mainly tests | Stable per-project writer identity is the right default |
| Project dir | Explicit `findEpicenterDir(import.meta.dir)` in config | Yes | `epicenter up -C` means `process.cwd()` may not be the config directory |
| API URL | `EPICENTER_API_URL` | Yes | Self-hosting and tests need an override |
| WebSocket impl | Runtime default | Yes | Tests and non-standard runtimes need injection |
| Peer | App daemon default, e.g. `{ id: 'fuji-daemon', name: 'Fuji Daemon', platform: 'node' }` | Yes | Presence identity has an obvious app default, but tests and custom hosts need stable names |
| Token getter | Prefer default only if dependency boundary stays clean | Yes | The host normally runs on the same machine as `epicenter auth login`, but app daemon subpaths should not grow an accidental CLI package cycle |
| Script route | App-specific connector default | Yes, by passing `route` to the connector | Avoids drift in the common case while preserving custom route support |

The preferred config is therefore:

```ts
const projectDir = findEpicenterDir(import.meta.dir);
const getToken = async () =>
	(await sessions.load(EPICENTER_API_URL))?.accessToken ?? null;

export default defineEpicenterConfig([
	openFuji({ projectDir, getToken }),
]);
```

And the fully explicit form remains available:

```ts
export default defineEpicenterConfig([
	openFuji({
		route: 'blog',
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
]);
```

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Config shape | `defineEpicenterConfig(HostedWorkspaceInput[])` | No export scanning, no fake single `workspaces` key, and default routes live with app daemon factories |
| Route id | `HostedWorkspace.route` | App daemon subpaths own the normal route and can export matching script helpers |
| Fuji daemon return | `HostedWorkspace` facade only | Persistence and materializers run privately |
| Readiness | Async host construction | A hosted workspace is ready once the factory resolves. The daemon should not carry a separate `whenReady` field. |
| Script typing | `ReturnType<typeof createFujiActions>` | Scripts depend on action factories, not config exports |
| Script route | App-specific connector default | `openFujiDaemonActions()` can use the same `FUJI_DAEMON_ROUTE` as `openFuji()` |
| Peer default | App daemon factory defaults `peer` | The normal daemon identity is obvious and overrideable |
| Token default | Conditional default | Add it only if the token helper can live in a small host-runtime module without an app to CLI cycle |

## Target API

```ts
export type HostedWorkspace = {
	route: string;
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
	readonly [EPICENTER_CONFIG]: true;
	hosts: HostedWorkspaceInput[];
};

export function defineEpicenterConfig(
	hosts: HostedWorkspaceInput[],
): EpicenterConfig {
	return Object.freeze({
		[EPICENTER_CONFIG]: true,
		hosts: Object.freeze([...hosts]),
	});
}
```

Duplicate routes are a runtime loader error, not a compile-time warning. The
record shape prevented duplicates by construction, but it also made config own
normal route names. The array shape keeps route ownership with app daemon
subpaths, and `loadConfig()` rejects duplicates before the daemon binds:

```txt
Duplicate daemon route "fuji" in /project/epicenter.config.ts.
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
const getToken = async () =>
	(await sessions.load(EPICENTER_API_URL))?.accessToken ?? null;

export default defineEpicenterConfig([
	openFuji({ projectDir, getToken }),
]);
```

Fuji's daemon subpath returns only the host surface:

```ts
// @epicenter/fuji/daemon
export const FUJI_DAEMON_ROUTE = 'fuji';

export async function openFuji({
	projectDir,
	route = FUJI_DAEMON_ROUTE,
	peer = defaultFujiDaemonPeer(),
	getToken,
	clientID = hashClientId(projectDir),
	apiUrl = EPICENTER_API_URL,
	webSocketImpl,
}: OpenFujiDaemonOptions) {
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
		route,
		actions: doc.actions,
		sync,
		presence,
		rpc,
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
		},
	} satisfies HostedWorkspace;
}

export function openFujiDaemonActions({
	route = FUJI_DAEMON_ROUTE,
	projectDir,
}: {
	route?: string;
	projectDir?: ProjectDir;
} = {}) {
	return connectDaemonActions<ReturnType<typeof createFujiActions>>({
		route,
		projectDir,
	});
}
```

Scripts type against action factories, not config exports:

```ts
import { openFujiDaemonActions } from '@epicenter/fuji/daemon';

const fuji = await openFujiDaemonActions();

await fuji.entries.create({ title: 'Hello' });
```

Local daemon actions and peer RPC actions are intentionally separate:

```txt
connectDaemonActions()
  script process
    │ Unix socket
    ▼
  local epicenter up daemon
    │ local /run route
    ▼
  hosted workspace action
```

```txt
createRemoteActions()
  local workspace peer
    │ presence.find(peerId)
    ▼
  remote peer clientID
    │ sync RPC
    ▼
  remote peer action
```

Use `connectDaemonActions()` when a script wants to call the project-local
`epicenter up` process by route key. Use `createRemoteActions()` when an
already-open workspace peer wants to call another peer by presence id over sync
RPC.

The loader sees one explicit host list:

```ts
const config = module.default;
const entries = await Promise.all(
	config.hosts.map(async (input) => {
		const host = await input;
		return { route: host.route, workspace: host };
	}),
);
```

In this model, `epicenter.config.ts` is not a reusable client module. It is the project-local daemon host manifest.

## Fuji Target

```ts
export type OpenFujiDaemonOptions = {
	route?: string;
	peer?: PeerDescriptor;
	getToken: () => Promise<string | null>;
	projectDir?: ProjectDir;
	clientID?: number;
	apiUrl?: string;
	webSocketImpl?: WebSocketImpl;
};

export async function openFuji({
	route = FUJI_DAEMON_ROUTE,
	peer = defaultFujiDaemonPeer(),
	getToken,
	projectDir = findEpicenterDir(),
	clientID = hashClientId(projectDir),
	apiUrl = EPICENTER_API_URL,
	webSocketImpl,
}: OpenFujiDaemonOptions) {
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
		route,
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
+   route,
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
export default defineEpicenterConfig([
	openFuji({ projectDir }),
]);
```

The current implementation keeps `getToken` explicit. Route and peer defaults
land without forcing `@epicenter/fuji/daemon` to import the CLI auth/session
store.

The default should not make app daemon subpaths import the whole CLI package if that creates a package cycle. Prefer one of these shapes:

1. Move the session token reader into a small host-runtime module that app daemon subpaths can depend on.
2. Add a narrow `@epicenter/cli/auth` or `@epicenter/cli/session` subpath that has no command or loader imports.
3. Keep `getToken` explicit until the repeated boilerplate is painful enough to justify the extraction.

The fallback explicit form is:

```ts
const sessions = createSessionStore();
const getToken = async () =>
	(await sessions.load(EPICENTER_API_URL))?.accessToken ?? null;

export default defineEpicenterConfig([
	openFuji({ projectDir, getToken }),
]);
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
hosts = config.hosts
entries = await Promise.all(
  hosts.map(async (input) => {
    const host = await input
    return { route: host.route, workspace: host }
  })
)
route key = host.route
```

Most daemon internals can stay stable because `loadConfig()` can still return `WorkspaceEntry[]`.

## Readiness Model

There is no `HostedWorkspace.whenReady`.

If a daemon workspace needs local setup before actions are safe to run, its host factory awaits that work before returning:

```ts
export async function openFuji(options) {
	const doc = openFujiDoc(options);
	const idb = attachIndexedDb(doc.ydoc, { name: 'fuji' });
	await idb.whenLoaded;

	const sync = attachSync(doc, { ... });

	return {
		route: 'fuji',
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

Scripts should not import hosted clients from `epicenter.config.ts`. In the normal case they should import app-specific daemon action helpers from the app package:

```ts
import { openFujiDaemonActions } from '@epicenter/fuji/daemon';

const fuji = await openFujiDaemonActions();
```

The generic primitive still exists for custom routes:

```ts
export async function connectDaemonActions<TActions>(options: {
	route: string;
	projectDir?: ProjectDir;
}): Promise<DaemonActions<TActions>>;
```

App daemon subpaths can build on it:

```ts
export const FUJI_DAEMON_ROUTE = 'fuji';

export function openFujiDaemonActions({
	route = FUJI_DAEMON_ROUTE,
	projectDir,
}: {
	route?: string;
	projectDir?: ProjectDir;
} = {}) {
	return connectDaemonActions<ReturnType<typeof createFujiActions>>({
		route,
		projectDir,
	});
}
```

`connectDaemon<TWorkspace>()` should be removed in the clean break. It made callers pass a workspace shape even though the runtime returned only an action proxy. `connectDaemonActions<TActions>()` takes the action root type directly.

`connectDaemonActions()` should not be confused with `createRemoteActions()`.
They both return typed action proxies, but their address spaces are different:

| API | Address | Transport | Caller has |
| --- | --- | --- | --- |
| `connectDaemonActions<TActions>({ route })` | config route key, e.g. `fuji` | local Unix socket | project directory |
| `createRemoteActions<TActions>({ presence, rpc }, peerId)` | presence peer id, e.g. `macbook` | sync RPC | live workspace peer |

If a project customizes the route, both the host and action helper take the same override:

```ts
export default defineEpicenterConfig([
	openFuji({ route: 'blog', projectDir }),
]);

const blog = await openFujiDaemonActions({
	route: 'blog',
});
```

## Implementation Plan

### Phase 1: Host Types

- [x] **1.1** Add `HostedWorkspace` and `defineEpicenterConfig`.
- [x] **1.2** Keep `WorkspaceEntry[]` as the internal daemon server input.
- [x] **1.3** Add tests for invalid route keys and non-workspace host values.
- [x] **1.4** Remove `whenReady` from hosted workspace types and daemon dispatch.

### Phase 2: Loader

- [x] **2.1** Teach `loadConfig()` to read default host config.
- [x] **2.2** Await every `HostedWorkspaceInput` before building `WorkspaceEntry[]`.
- [x] **2.3** Remove named export scanning instead of adding a compatibility bridge.
- [x] **2.4** Update loader errors from "config export" to "hosted workspace".

### Phase 3: Fuji

- [x] **3.1** Change `apps/fuji/src/lib/fuji/daemon.ts` to return `HostedWorkspace`.
- [x] **3.2** Add `route?: string` to daemon options, defaulted by app daemon constants.
- [x] **3.3** Stop exposing `ydoc`, `tables`, `yjsLog`, `sqlite`, and `markdown` from the daemon return.
- [x] **3.4** Keep daemon setup sync because the current node attachments hydrate synchronously.
- [x] **3.5** Keep `projectDir` overrideable and default it through `findEpicenterDir()`.
- [x] **3.6** Default `peer` in app daemon factories and keep it overrideable.
- [x] **3.7** Keep `getToken` explicit until a narrow auth/session runtime dependency exists.

### Phase 4: Call Sites and Docs

- [x] **4.1** Migrate example configs to `export default defineEpicenterConfig([...])`.
- [ ] **4.2** Replace docs that import from `epicenter.config.ts`.
- [x] **4.3** Add `connectDaemonActions<TActions>()`.
- [x] **4.4** Add app-specific helpers such as `openFujiDaemonActions()`.
- [x] **4.5** Update script examples to use app-specific daemon action helpers.

## Implementation Notes

- `@epicenter/workspace/daemon` now exports `defineEpicenterConfig`, `HostedWorkspace`, and related host types.
- `loadConfig()` now accepts only the default `defineEpicenterConfig([...])` shape. Named export scanning is removed.
- Duplicate routes are rejected by `loadConfig()` with `DuplicateRoute` before the daemon server binds.
- `connectDaemon<TWorkspace>()` was removed in favor of `connectDaemonActions<TActions>()`.
- `openFuji()` now returns a host facade with `route`, `actions`, `sync`, `presence`, `rpc`, and disposal only. The internal document, tables, Yjs log, SQLite materializer, and markdown materializer stay private.
- `openFujiDaemonActions()` destructures options in the signature and defaults to `FUJI_DAEMON_ROUTE`.

## Open Questions

1. **Where should the default token getter live?**
   - Options: app daemon subpaths import a narrow CLI auth/session subpath, session storage moves to a smaller host-runtime package, or config passes `getToken`.
   - Recommendation: default `getToken` only if the dependency stays narrow and cycle-free. Otherwise keep the explicit config closure.

2. **Should named export scanning remain as a compatibility bridge?**
   - Decision: remove it immediately.
   - Rationale: keeping both shapes would preserve the old "config as API module" ambiguity and weaken the route ownership model.

3. **Should `defineEpicenterConfig()` accept a raw array without a wrapper?**
   - Options: require `defineEpicenterConfig([...])`, accept `export default [...]`, or support both.
   - Decision: require the helper first. It gives the loader a reliable shape and gives TypeScript a place to validate host values.

4. **Should routes be overrideable?**
   - Options: hard-code app daemon routes, allow `openFuji({ route })`, or force custom users to call lower-level host constructors.
   - Decision: allow `route` overrides. Defaults should be strong, but custom host names should not require rebuilding the daemon factory.

5. **What should the local daemon action helper be called?**
   - Options: app-specific `openFujiDaemonActions()`, generic `connectDaemonActions<TActions>({ route })`, or generic `openDaemonActions<TActions>({ route })`.
   - Decision: expose app-specific helpers for common scripts and keep `connectDaemonActions` as the generic primitive.
