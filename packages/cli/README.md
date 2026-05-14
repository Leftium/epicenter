# @epicenter/cli

> Introspect and invoke `defineQuery` / `defineMutation` actions in your `epicenter.config.ts`, either locally or on a peer that's online right now.

Each verb is a one-line shell shortcut for one workspace primitive:

```
                 +--------+--------------------------------------------------+
                 | Verb   | Workspace primitive                              |
                 +--------+--------------------------------------------------+
   Enumerate     | list   | Object.entries(collaboration.actions)            |
   Invoke        | run    | invokeAction(...) | peer.invoke(path, input)     |
   Presence      | peers  | collaboration.peers.list()                       |
                 +--------+--------------------------------------------------+

 Cross-cutting: auth (machine session, pre-workspace)
```

`list` is the local view of what *this* device exposes across all hosted
routes. `peers` shows who is online across those routes. `run --peer
<peerId>` invokes a remote action through the selected route's
`collaboration.peers.find(peerId)?.invoke(path, input)` dispatch.

Anything that would need a flag to fan out across peers, loop, or
compose is a user-authored `.ts` script that imports app packages or
daemon action helpers and runs under `bun run`. The CLI is the
shell-friendly surface; scripts are the automation surface.

## Installation

Inside this monorepo:

```json
{
    "dependencies": {
        "@epicenter/cli": "workspace:*"
    }
}
```

The package exposes the `epicenter` binary via `src/bin.ts`.

## Commands

`run`, `list`, and `peers` dispatch to the local `epicenter up` daemon for the discovered project. Start it once at the top of your session (`epicenter up &`), then run as many shell-shortcut commands as you want. Without `up`, those three verbs error with a hint pointing back here. `up`, `down`, `ps`, `logs`, and `auth` work without a daemon.

```bash
# auth: machine session (pre-workspace; no project flag)
epicenter auth login
epicenter auth status
epicenter auth logout

# up: bring every hosted route online as a callable peer (run once per session)
epicenter up &
epicenter up -C examples/notes-cross-peer/peer-b &

# list: what actions are exposed on this device
epicenter list                                      # full tree
epicenter list tabManager                           # route subtree
epicenter list tabManager.tabs_open                 # action detail with JSON input shape

# run: do one (locally, or on a remote peer with --peer)
epicenter run tabManager.tabs_list
epicenter run tabManager.tabs_open '{"url":"https://..."}'
epicenter run tabManager.tabs_open @payload.json
cat payload.json | epicenter run tabManager.tabs_open
epicenter run tabManager.tabs_list --peer 0xabc

# peers: who is online right now (awareness snapshot)
epicenter peers
epicenter peers -C examples/notes-cross-peer/peer-b
```

`run` resolves the route prefix against the hosted routes declared by
`epicenter.config.ts`; the suffix is the snake_case key in
`workspace.actions`. With `--peer`, the route prefix selects the local RPC
attachment, then the action key is sent to the
remote peer.

### Local vs. remote

`list` is local: it describes the actions exposed by this device's config,
prefixed by route. `run` is local by default and remote when `--peer
<deviceId>` is set; the verb and schema are unchanged, only the dispatch
target moves.

Fan-out across peers (e.g. "who exposes action X?") is a five-line
script that walks `collaboration.peers.list()` and calls `peer.describe()`
(or filters `peer.actionKeys` directly when full schemas aren't needed).
The CLI deliberately does not grow a flag for it.

Peer awareness has a ~30s liveness window: a peer that crashed recently may still appear; a peer that just connected may take a beat to show up. `run --peer` polls for the target until it resolves or `--wait <ms>` expires (default 5000). `peers` reads the current awareness snapshot one-shot.

### Common flags

| Flag | Alias | Commands | Purpose |
| ---- | ----- | -------- | ------- |
| `-C` | none | `up`, `down`, `logs`, `list`, `run`, `peers` | Start directory for project discovery. Defaults to the current directory. |
| `--peer` | none | `run` | Address a remote peer by `deviceId`. Dispatches the invocation over the selected route's RPC channel. |
| `--wait` | none | `run --peer` (default 5000) | Ms to wait for peer resolution and the RPC call. |
| `--format` | none | `list`, `run`, `peers` | `json` or `jsonl`. Pretty-prints on TTY, compact when piped. Without it, commands emit their human-readable shape (tree / value / table). |

`auth` intentionally takes no project flag: it manages the local machine auth session, not workspace state. The auth server is the compiled Epicenter API URL.

### Exit codes

Scripts can distinguish these cases without parsing stderr:

| Code | Meaning |
| ---- | ------- |
| `1` | Usage or setup error: unknown command, bad flag, missing config, unknown route, or action key does not exist. |
| `2` | Runtime error: local action returned `Err`, or a remote RPC completed with a failure (ActionFailed, Timeout, PeerOffline, Disconnected). |
| `3` | Peer miss: `--peer <target>` did not resolve within `--wait`. Distinct from `2` so scripts can retry or re-enumerate peers. |

## What your `epicenter.config.ts` exports

An explicit daemon route config: default-export an object shaped like
`{ daemon: { routes: [...] } }`. `defineConfig()` is the typed helper for
authoring that object. Route definitions are delayed starters. The CLI loader
injects the project context when it starts them, so configs do not need to call
`findEpicenterDir(import.meta.dir)` or depend on the shell's current directory.

```ts
// epicenter.config.ts
import * as Y from 'yjs';
import {
	attachTables,
	defineActions,
	defineMutation,
	defineQuery,
	defineTable,
	openCollaboration,
	toWsUrl,
} from '@epicenter/workspace';
import { defineConfig } from '@epicenter/workspace/daemon';
import { createMachineAuthClient } from '@epicenter/auth/node';
import Type from 'typebox';
import { type } from 'arktype';

const SavedTab = defineTable(type({ id: 'string', title: 'string', url: 'string', _v: '1' }));

async function openTabManagerDaemon() {
	const ydoc = new Y.Doc({ guid: 'epicenter.tab-manager' });
	const tables = attachTables(ydoc, { savedTabs: SavedTab });
	const actions = defineActions({
		saved_tabs_list: defineQuery({
			description: 'List all saved tabs',
			handler: () => tables.savedTabs.getAllValid(),
		}),
		saved_tabs_delete: defineMutation({
			input: Type.Object({ id: Type.String() }),
			description: 'Delete a saved tab by id',
			handler: ({ id }) => tables.savedTabs.delete(id),
		}),
	});
	const auth = await createMachineAuthClient();
	const collaboration = openCollaboration(ydoc, {
		url: toWsUrl('https://api.epicenter.so/workspaces/epicenter.tab-manager'),
		openWebSocket: auth.openWebSocket,
		identity: {
			id: 'tab-manager-daemon',
			name: 'Tab Manager Daemon',
			platform: 'node',
		},
		actions,
	});

	return {
		ydoc,
		tables,
		collaboration,

		async [Symbol.asyncDispose]() {
			ydoc.destroy();
			await collaboration.whenDisposed;
		},
	};
}

export default defineConfig({
	daemon: {
		routes: [{ route: 'tabManager', start: () => openTabManagerDaemon() }],
	},
});
```

App packages publish their schema on npm. Runtime recipes (script entries,
daemon routes) ship as jsrepo blocks the consumer copies into their tree.
A Fuji config that uses the daemon-route block looks like this:

```ts
// epicenter.config.ts
import { defineConfig } from '@epicenter/workspace/daemon';
import { defineFujiDaemon } from './blocks/daemon-route';

export default defineConfig({
	daemon: {
		routes: [defineFujiDaemon()],
	},
});
```

Add the block with `bunx jsrepo add epicenter/fuji/daemon-route`. The block
defaults auth through `createMachineAuthClient()` from `@epicenter/auth/node`
and is yours to edit (override the auth source, the sync URL, the route name,
etc.) without breaking sync compatibility.

## Exposing operations via CLI

There is no auto-expose for `attachTable` / `attachKv` methods. If you want an operation available at `epicenter run`, wrap it in `defineQuery` or `defineMutation` inside your bundle. Expose only what you actually want available from the CLI. Everything else stays as an in-process method on the Table/Kv helper, usable from `scripts/*.ts`.

This is deliberate. Auto-exposing CRUD would put methods nobody asked for in your CLI tree, and the curated set would either be too narrow for some apps or too wide for others. Explicit wrapping keeps the CLI surface intentional and small.

The common convention is a flat registry keyed by `<domain>_<action>` snake_case strings, with cross-cutting actions as standalone keys at the same level:

```ts
const actions = defineActions({
    // tabs domain
    tabs_list: defineQuery({ ... }),
    tabs_open: defineMutation({ ... }),

    // bookmarks domain
    bookmarks_list: defineQuery({ ... }),

    // Cross-cutting actions sit beside the domain-prefixed keys
    import_backup: defineMutation({ ... }),
});

const collaboration = openCollaboration(ydoc, {
    url, identity, openWebSocket: auth.openWebSocket, actions,
});

return {
    ydoc,
    tables,
    collaboration,

    async [Symbol.asyncDispose]() {
        ydoc.destroy();
        await collaboration.whenDisposed;
    },
};
```

CLI keys are `<route>.<action_key>`: `tabManager.tabs_list`, `tabManager.bookmarks_list`, `tabManager.import_backup`.

The CLI iterates `runtime.collaboration.actions` with `Object.entries(...)`. Infrastructure such as `ydoc`, tables, persistence, and materializers is not public unless you deliberately add it as an entry in the flat `actions` registry passed to `openCollaboration`.

## Naming Routes

Every `route` on a daemon route definition becomes the first segment of every
CLI selector. A config with a single route can use any name (`tabManager`, `tm`,
`w`), but once you add a second route, the prefix disambiguates them, so a
readable name ages better than a one-letter one.

There is no named-export scanning. Even a config with one workspace
default-exports `{ daemon: { routes } }`. This keeps daemon route definitions
explicit and lets app packages own their default route names.

```ts
// epicenter.config.ts
import { defineConfig } from '@epicenter/workspace/daemon';
import { defineFujiDaemon } from './blocks/daemon-route';

export default defineConfig({
	daemon: {
		routes: [
			{ route: 'tabManager', start: () => openTabManagerDaemon() },
			defineFujiDaemon(),
		],
	},
});
// epicenter run tabManager.tabs_list
// epicenter run fuji.entries_list
```

The Y.Doc GUID and the route serve different purposes:

- `'epicenter.tab-manager'`: the Y.Doc's GUID. Controls persistence file, sync room, CRDT identity. Don't change this on a workspace with real data.
- `tabManager`: the daemon route. Controls the CLI path prefix. Safe to rename if you update scripts that call that route.

You can rename the route without touching persistent data. If you decide the
prefix is too verbose six months in, rename `tabManager` to `tm` and every
sync/persistence artifact stays exactly where it is.

## Scripting

Skip the CLI entirely for anything non-trivial:

```ts
// scripts/export-tabs.ts
import { connectTabManagerDaemonActions } from '@example/tab-manager/daemon';
import { writeFile } from 'node:fs/promises';

const tabManager = await connectTabManagerDaemonActions();
const result = await tabManager.savedTabs.list();
if (result.error) throw result.error;

await writeFile('./tabs.json', JSON.stringify(result.data, null, 2));
```

```bash
bun run scripts/export-tabs.ts
```

Scripts are strictly more powerful than the CLI: you get arbitrary control
flow, package imports, daemon action helpers, and any npm dependency. Reach for
the CLI for one-shot invocations of things you've deliberately exposed; reach
for scripts for everything else.

## Public API

```ts
import {
    createCLI,              // binary entry (used by bin.ts)
    loadDaemonConfig,       // imports and validates epicenter.config.ts
    startDaemonRoutes,      // starts validated route definitions
} from '@epicenter/cli';
```

Node-side auth helpers live in `@epicenter/auth/node`:

```ts
import { createMachineAuthClient } from '@epicenter/auth/node';
import * as machineAuth from '@epicenter/auth/node/machine-auth';
```

## Design docs

- `specs/20260421T155436-cli-scripting-first-redesign.md`: base surface (`auth`, `list`, `run`) and the scripting-first rationale; why 11 commands collapsed to the current grid.
- `specs/20260423T174126-cli-remote-peer-rpc.md`: the remote column: `peers` + `run --peer` over the sync room's RPC channel.
- `specs/20260423T010000-cli-json-only-input.md`: `run` takes JSON only; no schema-to-flags bridge.
