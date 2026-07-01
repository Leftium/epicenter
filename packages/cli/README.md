# @epicenter/cli

> Introspect and invoke `defineQuery` / `defineMutation` actions exposed by the configured mount.

Each verb is a one-line shell shortcut for one workspace primitive:

```
                 +------------+---------------------------------------------+
                 | Verb       | Workspace primitive                         |
                 +------------+---------------------------------------------+
   Enumerate     | list       | Object.entries(runtime.actions)             |
   Invoke        | run        | local daemon invoke                         |
   Presence      | peers      | collaboration.peers.list()                  |
                 +------------+---------------------------------------------+

 Supporting systems: auth (machine session), daemon (process lifecycle)
```

## Targeting an environment

When you iterate on `apps/api`, you want CLI commands hitting your local server, not prod. The CLI reads `EPICENTER_API_URL` from the environment; named scripts wrap the two real workflows so the target is always explicit.

| I want to...                                          | I run...                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Develop against my local API server                   | `bun run cli:local auth login`                                         |
| Run from source against prod (rare: bug repro, demos) | `bun run cli auth login`                                               |
| Use the published binary (end user)                   | `epicenter auth login`                                                 |
| Override the target anywhere                          | `EPICENTER_API_URL=https://staging.example.com bun run cli auth login` |

Tokens are stored per API target so prod and local sessions coexist. Each target writes one file at `<dataDir>/auth/<host>.json`, where `<dataDir>` is the platform user-data directory from `env-paths('epicenter')` and `<host>` is the API host with `:` replaced by `_`. A fresh `cli:local auth login` will not overwrite your prod session. The daemon freezes its target at boot; to retarget, `daemon down` then `daemon up` again.

`EPICENTER_DATA_DIR=<path>` overrides `<dataDir>` itself (the user-data directory above; today the only user-global state stored there is cached credentials). Escape hatch for Nix, snap, ephemeral homes, and the test suite.

The same env var and scripts apply to every command that talks to the API, including `daemon`, not just `auth`.

## Commands

`epicenter daemon up` opens the mount the Epicenter root's `epicenter.config.ts` declares. `list`, `run`, and `peers` dispatch to that local daemon over its Unix socket.

```bash
epicenter auth login

epicenter daemon up -C ~/workspace
epicenter daemon ps
epicenter daemon logs -C ~/workspace
epicenter daemon down -C ~/workspace

epicenter list -C ~/workspace
epicenter list entries_update -C ~/workspace

epicenter run entries_update '{"id":"entry_1","tags":["triaged"]}' -C ~/workspace
epicenter run entries_update '{"id":"entry_1","tags":["triaged"]}' --peer user-1 -C ~/workspace

epicenter peers -C ~/workspace
```

`-C` is a start directory for Epicenter-root discovery. Discovery walks upward until it finds `epicenter.config.ts`, then the daemon opens the mount that config declares. Discovery is upward-only and never scans down, so run from inside your Epicenter folder (or any directory under it) or pass `-C <epicenter-root>`. From a repo whose Epicenter folder lives at `repo/apps`, that is `epicenter daemon up -C apps`.

## Cross-device tools

Your signed-in devices reach each other's tools over the relay floor: one per-user authenticated relay routes a typed channel to a device over the account-room WebSocket each daemon already holds. You ask for a device by its nodeId, not a tool floating in a global namespace, and the channel reaches a named route on that device's daemon (a route like `books` spawns that device's MCP server).

A route is default-closed over the relay. The relay stamps an unforgeable identity on every channel (the authenticated account it belongs to), and a device admits an inbound channel only when the caller is your own account AND the route is explicitly relay-exposed. A sensitive route (`books` exposes financial data) stays refused until the operator opts it in with `--relay-expose`, knowingly accepting the relay's plaintext ceiling (a self-hosted relay removes the third party; privacy is which relay you run).

| Verb | What it does |
| --- | --- |
| `epicenter tools <device>` | List a device's MCP tools for one route (default `books`) |
| `epicenter call <device> <route> <tool> [input]` | Call one tool on a device's route |

`<device>` is the target's nodeId, printed in its `epicenter daemon up` banner. Only a device currently online on the relay is reachable.

### Two-machine smoke

To confirm cross-device reach end to end, sign two machines into the same account and run:

```bash
# Machine B (the target): expose `books` over the relay floor. It is refused by
# default (financial data), so this knowingly accepts the trusted-relay ceiling.
# The banner prints "account room: online as <nodeId>"; note B's nodeId.
epicenter daemon up -C <root> --relay-expose books

# Machine A (the caller):
epicenter daemon up -C <root>

# On machine A, after both account rooms have synced:
epicenter call <B-nodeId> books <tool>
```

Two things gate this. Both machines must be signed into the same account and reach the same sync server, because the relay floor rides the account-room WebSocket each device holds; if `epicenter tools <B-nodeId>` on A cannot reach B, that is a control-plane sync problem, not a transport one. And the target must have opted `books` in with `--relay-expose`; without it the acceptor refuses every relay channel by default. No device key, dial address, or `verify` is involved: the relay's same-account vouch plus the relay-exposed route is the whole gate.

## Exit codes

`run` is the only command with granular codes, so a script can branch on the failure kind:

| Code | `run` | `list`, `peers` |
| --- | --- | --- |
| `0` | success | success |
| `1` | usage error (unknown action, action input that fails the action's schema, bad `--peer` input) or no daemon running | any failure (no daemon, bad arguments) |
| `2` | runtime error: the local action returned `Err`, or the remote RPC failed | (not used) |
| `3` | peer not found: `--peer <target>` did not resolve within `--wait` | (not used) |

`daemon up` exits `1` on startup failure (already running, bad config, auth) and `0` on clean shutdown. `daemon down`, `ps`, and `logs` exit `0`: a missing daemon or an empty log is reported, not treated as an error.

Error text goes to stderr; machine-readable output (`--format json|jsonl`, tables, and `run` results) goes to stdout.

## Epicenter Roots And Mounts

`epicenter.config.ts` marks the Epicenter root and declares its mount. One folder is one app is one mount: the default export is a single `Mount`. App packages ship mount factories that return `Mount` values; `Mount.name` is the display label `epicenter list` prints as its header. The folder that holds `epicenter.config.ts` is your Epicenter folder: Epicenter owns its direct children, so the mount's visible markdown projection is a direct child folder.

```ts
import { honeycrisp } from "@epicenter/honeycrisp/mount";

export default honeycrisp();
```

The returned `Mount.name` is `honeycrisp`, so `epicenter list` prints `honeycrisp` as its header regardless of the Epicenter folder name. Actions are addressed by their bare key (`epicenter run folders_delete`): the daemon serves one mount, so the key alone is unambiguous.

The folder that holds `epicenter.config.ts` is your Epicenter folder. `.epicenter/` and the generated projection are direct children:

```
repo/                      unreserved repo root
└── honeycrisp/             Epicenter root (folder name is your choice)
    ├── epicenter.config.ts   tracked, marks the Epicenter root
    ├── .epicenter/           ignored, machine state for this root
    └── notes/                generated Markdown projection (one folder per table)
```

Put `epicenter.config.ts` in a folder dedicated to one app. The marker is the config file, not the folder name. Run several apps by giving each its own folder, each its own root.

Writing a custom mount inline uses `defineMount` from `@epicenter/workspace/daemon`:

```ts
import { defineMount } from "@epicenter/workspace/daemon";

export default defineMount({
  name: "notes",
  async open({ epicenterRoot, mount, session }) {
    // Open the long-lived runtime.
    // `mount` is the canonical mount name carried on the Mount object.
    // Return { actions, [Symbol.asyncDispose] }, or `inactive(reason)`.
  },
});
```

`Mount.name` is the header `epicenter list` prints; actions are addressed by their bare key.

`.epicenter/` holds the Epicenter root's generated machine state such as SQLite materializers, Yjs update logs, markdown materializers, and its generated `.gitignore`. It is not a registry. Runtime files live outside the Epicenter root: sockets and daemon metadata use the OS runtime directory, while daemon logs use the platform log directory from `env-paths`.

## Scripting

Use scripts for anything beyond one-shot CLI calls:

```ts
import { connectDaemonActions } from "@epicenter/workspace/node";
import type { HoneycrispActions } from "@epicenter/honeycrisp";

const honeycrisp = await connectDaemonActions<HoneycrispActions>();

await honeycrisp.folders_delete({ folderId });
```

Scripts get normal TypeScript control flow. The CLI stays small: list, run, peers, and daemon lifecycle.

## Public API

```ts
import { createCLI } from "@epicenter/cli";
```
