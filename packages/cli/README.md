# @epicenter/cli

> Introspect and invoke `defineQuery` / `defineMutation` actions in your `epicenter.config.ts`, either locally or on a peer that's online right now.

The surface is two verbs × two scopes, plus a pre-workspace session command:

```
               Local            Remote
             ┌─────────┬─────────────────────────────┐
 Enumerate   │  list   │  list --peer / list --all   │
 Invoke      │  run    │  run --peer                 │
             └─────────┴─────────────────────────────┘

 Presence:    peers (who's online — separate from capability)
 Cross-cutting: auth (server session, pre-workspace)
```

`list` is the single command for inspecting actions anywhere — local by
default, remote with `--peer <deviceId>`, or self + every connected peer
with `--all`. `peers` answers a different question: who's reachable right
now, regardless of what they offer.

Every command earns its place against that grid. Anything bigger — bulk operations, exports, ad-hoc transforms — is a user-authored `.ts` script that imports the config and runs under `bun run`. The config self-loads at import time, so there is nothing for the CLI to bootstrap.

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

## The four commands

```bash
# auth — server session (pre-workspace; no --dir or --workspace)
epicenter auth login                              # defaults to https://api.epicenter.so
epicenter auth login https://self-hosted.example  # self-hosted override
epicenter auth status                             # most recent session
epicenter auth logout                             # most recent session

# list — what actions are exposed (local by default; --peer / --all for remote)
epicenter list                                      # local: every export + full tree
epicenter list tabManager.savedTabs                 # local subtree
epicenter list tabManager.savedTabs.create          # local action detail with JSON input shape
epicenter list --peer 0xabc                         # remote: that peer's full tree
epicenter list --peer 0xabc tabManager.savedTabs    # remote subtree on that peer
epicenter list --all                                # self + every connected peer
epicenter list --all tabManager.savedTabs.create    # who offers this action?

# run — do one (locally, or on a remote peer with --peer)
epicenter run tabManager.savedTabs.list
epicenter run tabManager.savedTabs.create '{"title":"Hi","url":"https://..."}'
epicenter run tabManager.savedTabs.create @payload.json
cat payload.json | epicenter run tabManager.savedTabs.create
epicenter run tabManager.savedTabs.list --peer 0xabc

# peers — who's online right now (presence snapshot; no offers)
epicenter peers
epicenter peers -w tabManager
```

`run` resolves the first path segment against the named exports of `epicenter.config.ts`; everything after walks into the underlying document handle until it hits a branded `defineQuery` / `defineMutation` node.

### Local vs. remote

`list` defaults to the local config — the fast, deterministic view of what your code exposes. Add `--peer <deviceId>` to read another peer's published manifest, or `--all` to fan out across self plus every connected peer. `--peer` and `--all` are mutually exclusive (`--all` already includes everyone). `peers` is a separate, presence-only command: who's reachable right now, regardless of what (if anything) they offer. `run` is local by default and remote when `--peer <deviceId>` is set; the verb and schema are unchanged, only the dispatch target moves.

Peer presence has a ~30s liveness window (inherited from Yjs awareness): a peer that crashed recently may still appear; a peer that just connected may take a beat to show up. `run --peer` polls for the target until it resolves or `--wait <ms>` expires (default 5000). `list --peer` and `list --all` poll up to `--wait <ms>` (default 500 — the awareness burst usually lands in the same write window as the sync handshake; the small grace covers concurrent peer joins). `peers` defaults to `--wait 500` for the same reason; pass `--wait 0` for a true one-shot snapshot.

### Common flags

| Flag | Alias | Commands | Purpose |
| ---- | ----- | -------- | ------- |
| `--dir` | `-C` | `list`, `run`, `peers` | Directory containing `epicenter.config.ts` (default `.`). Mirrors `git -C`. |
| `--workspace` | `-w` | `list`, `run`, `peers` | Narrow to one export when the config has multiple workspaces. |
| `--peer` | — | `list`, `run` | Address a remote peer by `deviceId`. On `list`, sources the action manifest from that peer's awareness; on `run`, dispatches the invocation over the sync room's RPC channel. |
| `--all` | — | `list` | Source from self plus every connected peer in one invocation. Mutually exclusive with `--peer`. |
| `--wait` | — | `list --peer` / `list --all` (default 500), `run --peer` (default 5000), `peers` (default 500) | Ms to wait for awareness to populate. `0` = one-shot snapshot. On `run --peer`, covers peer resolution *and* the RPC call. |
| `--format` | — | `list`, `run`, `peers` | `json` or `jsonl`. Pretty-prints on TTY, compact when piped. Without it, commands emit their human-readable shape (tree / value / table). |

`auth` intentionally takes no workspace flags — it manages server sessions, not workspace state. The server URL is a positional with a default of `https://api.epicenter.so`; self-hosters pass their own URL.

### Exit codes

Scripts can distinguish these cases without parsing stderr:

| Code | Meaning |
| ---- | ------- |
| `1` | Usage or setup error — unknown command, bad flag, missing config, action path doesn't exist, workspace name doesn't match. |
| `2` | Runtime error — local action returned `Err`, or a remote RPC completed with a failure (ActionFailed, Timeout, PeerOffline, Disconnected). |
| `3` | Peer miss — `--peer <target>` did not resolve within `--wait`. Distinct from `2` so scripts can retry or re-enumerate peers. |

## What your `epicenter.config.ts` must export

An **opened handle** — not a factory. A factory has no id to call on its own; a handle already has refcount `+1`, sync connected, persistence open.

```ts
// epicenter.config.ts
import * as Y from 'yjs';
import {
    defineDocument,
    defineTable,
    attachTables,
    defineQuery,
    defineMutation,
} from '@epicenter/workspace';
import Type from 'typebox';
import { type } from 'arktype';

const SavedTab = defineTable(type({ id: 'string', title: 'string', url: 'string', _v: '1' }));

const tabManagerFactory = defineDocument((id) => {
    const ydoc = new Y.Doc({ guid: id });
    const tables = attachTables(ydoc, { savedTabs: SavedTab });

    return {
        ydoc,
        tables,

        // Actions live beside the data they operate on.
        // Only the operations you wrap with defineQuery/defineMutation
        // show up in `epicenter list`.
        savedTabs: {
            list: defineQuery({
                description: 'List all saved tabs',
                handler: () => tables.savedTabs.getAllValid(),
            }),
            delete: defineMutation({
                input: Type.Object({ id: Type.String() }),
                description: 'Delete a saved tab by id',
                handler: ({ id }) => tables.savedTabs.delete(id),
            }),
        },

        [Symbol.dispose]() { ydoc.destroy(); },
    };
});

// The opened handle is what the CLI and scripts consume.
export const tabManager = tabManagerFactory.open('epicenter.tab-manager');
```

## Exposing operations via CLI

There is no auto-expose for `attachTable` / `attachKv` methods. If you want an operation available at `epicenter run`, wrap it in `defineQuery` or `defineMutation` inside your bundle. Expose only what you actually want available from the CLI — everything else stays as an in-process method on the Table/Kv helper, usable from `scripts/*.ts`.

This is deliberate. Auto-exposing CRUD would put methods nobody asked for in your CLI tree, and the curated set would either be too narrow for some apps or too wide for others. Explicit wrapping keeps the CLI surface intentional and small.

The convention is to group related actions into a nested object named after the domain they operate on:

```ts
return {
    ydoc,
    tables,

    savedTabs: {                                       // domain
        list: defineQuery({ ... }),                    // action
        delete: defineMutation({ ... }),
    },
    bookmarks: {
        list: defineQuery({ ... }),
    },

    // Cross-cutting actions live at the top
    importBackup: defineMutation({ ... }),

    [Symbol.dispose]() { ydoc.destroy(); },
};
```

CLI paths: `tabManager.savedTabs.list`, `tabManager.bookmarks.list`, `tabManager.importBackup`.

The framework doesn't mandate this shape — `iterateActions` walks the whole bundle and finds anything branded, no matter where it sits. Two other placements work if you prefer them:

- A dedicated `actions:` slot — adds one path segment (`tabManager.actions.savedTabs.list`) in exchange for visual separation between data and operations.
- Flat at the top — shortest path (`tabManager.listSavedTabs`) but action names have to encode the domain, and the top level becomes a grab-bag.

Domain-nested is the recommended convention because it reads naturally and co-locates each action with the data it uses.

## Naming your exports

Every workspace handle is a **named export**. The export name becomes the first segment of every CLI dot-path. A config with a single workspace can use any name — `tabManager`, `tm`, `w` — but once you add a second workspace, the prefix disambiguates them, so a readable name ages better than a one-letter one.

There is no default-export shorthand. Even a config with one workspace uses a named export. This keeps paths stable when you later add a second workspace: `tabManager.savedTabs.list` on day 1 is still `tabManager.savedTabs.list` on day 180 after you add a second workspace. A default-export shortcut would silently invalidate every script, doc, and CI job using the old path the moment you grew past one workspace.

```ts
// epicenter.config.ts
export const tabManager = tabManagerFactory.open('epicenter.tab-manager');
export const fuji       = fujiFactory.open('epicenter.fuji');
// epicenter run tabManager.savedTabs.list
// epicenter run fuji.entries.list
```

The GUID you pass to `.open()` and the export name serve **different purposes**:

- `'epicenter.tab-manager'` — the Y.Doc's GUID. Controls persistence file, sync room, CRDT identity. Don't change this on a workspace with real data.
- `tabManager` — the JS binding name. Controls the CLI path prefix. Safe to rename any time.

You can rename the export freely without touching any persistent data. If you decide the prefix is too verbose six months in, rename `tabManager` → `tm` and every sync/persistence artifact stays exactly where it is.

## Scripting

Skip the CLI entirely for anything non-trivial:

```ts
// scripts/export-tabs.ts
import { tabManager } from '../epicenter.config';
import { writeFile } from 'node:fs/promises';

try {
    await tabManager.whenReady;
    const tabs = tabManager.tables.savedTabs.getAllValid();
    await writeFile('./tabs.json', JSON.stringify(tabs, null, 2));
} finally {
    tabManager.dispose();
}
```

```bash
bun run scripts/export-tabs.ts
```

Scripts are strictly more powerful than the CLI: you get the full Table/Kv APIs, arbitrary control flow, and any npm dependency. Reach for the CLI for one-shot invocations of things you've deliberately exposed; reach for scripts for everything else.

## Public API

```ts
import {
    createCLI,              // binary entry (used by bin.ts)
    loadConfig,             // { entries: [{ name, handle }], dispose() }
    createSessionStore,     // device-code session persistence
    createAuthApi,          // typed Better Auth client
    epicenterPaths,         // home, authSessions, persistence(id)
    attachSessionUnlock,    // apply stored encryption keys to an EncryptionAttachment
} from '@epicenter/cli';
```

## Design docs

- `specs/20260421T155436-cli-scripting-first-redesign.md` — base surface (`auth`, `list`, `run`) and the scripting-first rationale; why 11 commands collapsed to the current grid.
- `specs/20260423T174126-cli-remote-peer-rpc.md` — the remote column: `peers` + `run --peer` over the sync room's RPC channel.
- `specs/20260423T010000-cli-json-only-input.md` — `run` takes JSON only; no schema-to-flags bridge.
