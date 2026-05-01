# Daemon Route Map Config

**Date**: 2026-05-01
**Status**: Implemented
**Author**: AI-assisted
**Branch**: codex/explicit-daemon-host-config

## One-Sentence Test

`epicenter.config.ts` declares named daemon routes; `epicenter up` starts each route into a live workspace peer and exposes those peers through one local daemon socket.

## Overview

The daemon config now uses a route map instead of a host array. Route names live in the project config, route values are delayed modules, and each started runtime derives `workspaceId` from its opened Y.Doc.

## Motivation

### Current State Before This Change

The previous API treated each daemon entry as a host definition:

```ts
export default defineEpicenterConfig({
	hosts: [
		defineDaemon({
			route: 'fuji',
			start: () => openFujiRuntime(),
		}),
	],
});
```

This created three naming problems:

1. **Host sounded like a process**: `epicenter up` starts one daemon process, not one process per entry.
2. **Route was nested inside the value**: Duplicate routes had to be detected after walking an array.
3. **App helpers owned local names**: `defineFujiDaemon({ route })` made the package helper responsible for a project-local address.

### Desired State

The config should show the daemon as one project-level concern with named routes:

```ts
export default defineEpicenterConfig({
	daemon: {
		routes: {
			fuji: fujiDaemon(),
			notes: notesDaemon(),
		},
	},
});
```

The route key becomes the first CLI path segment. The route module starts the live runtime only after the loader supplies project context.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Config file name | Keep `epicenter.config.ts` | The file remains the project entry point. `daemon.routes` is one section inside it, leaving room for future project-level config. |
| Top-level daemon shape | `daemon.routes` record | A daemon is one process with many named routes. The record makes route identity visible and prevents duplicate routes by construction. |
| App helper shape | `fujiDaemon() -> DaemonRouteModule` | App helpers return delayed callbacks. They do not own local route names. |
| Workspace identity | Runtime `workspaceId` derived from `doc.ydoc.guid` | The Y.Doc guid is the durable CRDT, sync, and persistence identity. Duplicating it on the route module creates drift. |
| HTTP framework | Keep Hono internal | Hono serves the local socket API. Fuji and other apps are not HTTP route trees; they are workspace peers behind generic `/run`, `/list`, and `/peers` endpoints. |

## Architecture

```txt
epicenter.config.ts
┌────────────────────────────────────┐
│ daemon.routes                      │
│  ├─ fuji: fujiDaemon()             │
│  └─ notes: notesDaemon()           │
└────────────────────────────────────┘
                 │
                 ▼
loadConfig(projectDir)
┌────────────────────────────────────┐
│ validate route keys                │
│ call route module with context     │
│ routes.fuji({ projectDir, route }) │
└────────────────────────────────────┘
                 │
                 ▼
live daemon runtime
┌────────────────────────────────────┐
│ workspaceId: doc.ydoc.guid         │
│ actions                            │
│ sync                               │
│ presence                           │
│ rpc                                │
│ dispose                            │
└────────────────────────────────────┘
                 │
                 ▼
one local daemon socket
┌────────────────────────────────────┐
│ /list  -> all route action trees   │
│ /run   -> route-prefixed dispatch  │
│ /peers -> all route presences      │
└────────────────────────────────────┘
```

## Fuji Shape

```ts
export function fujiDaemon(options = {}): DaemonRouteModule {
	return ({ projectDir }) => {
		const doc = openFujiDoc({ clientID: hashClientId(projectDir) });
		const sync = attachSync(doc, { ... });
		const presence = sync.attachPresence({ peer });
		const rpc = sync.attachRpc(doc.actions);

		return {
			workspaceId: doc.ydoc.guid,
			actions: doc.actions,
			sync,
			presence,
			rpc,
			[Symbol.dispose]() {
				doc[Symbol.dispose]();
			},
		};
	};
}
```

## Implementation Notes

- `defineDaemon()` and host branding are removed from the public daemon config surface.
- `defineEpicenterConfig()` still brands the default export so the loader can reject arbitrary objects.
- `loadConfig()` validates route keys before starting any route module.
- The route context includes `{ projectDir, route }`.
- App-specific script helpers still use route constants, for example `openFujiDaemonActions({ route })`.
