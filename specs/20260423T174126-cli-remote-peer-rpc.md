# CLI Remote Peer RPC

**Date**: 2026-04-23
**Status**: Draft
**Author**: AI-assisted
**Depends on**: `specs/20260423T010000-unify-dot-path-format.md` (shipped)

## Overview

The CLI invokes actions locally against opened handles today. This spec extends it to invoke actions on **remote peers** connected to the same Yjs sync room, using the existing RPC-over-Yjs infrastructure.

Adds:
- `epicenter peers` — enumerate connected peers per workspace
- `--peer <target>` flag on `run` — invoke actions on a remote peer

No new primitives. No wire protocol changes. No framework-injected actions. The CLI uses the **local config as the authoritative schema**, and remote peers are pure executors.

## Motivation

The RPC pipeline is already built end-to-end:

```
sync.rpc(clientId, action, input)              ← client, attach-sync.ts:779-840
[101, REQUEST, reqId, targetId, ...]           ← wire, protocol.ts:449-621
DO routes by controlledClientIds               ← server, base-sync-room.ts:368-442
dispatchAction(actions, path, input)           ← receiver, actions.ts:471-488
[101, RESPONSE, reqId, ...]
```

Every other client (browser extension, desktop app) uses `sync.rpc` already. The CLI — despite being the "scripting-first" surface — has no way to reach remote peers.

## Architecture

The CLI's local config is the authoritative source for action trees, schemas, and typing. Remote peers are invocation targets, not schema sources.

```
┌──────────────────────────────────────────────────────────┐
│ LOCAL                                                    │
│                                                          │
│  epicenter.config.ts                                     │
│    └─ handle (actions, schemas, sync, awareness)         │
│          ↑                                               │
│          │ (authoritative for everything CLI does)       │
│          │                                               │
│  CLI ────┘                                               │
│   ├── list       → walk handle's actions                 │
│   ├── peers      → read handle.awareness.getStates()     │
│   ├── run x.y    → handle.x.y(input)  [direct call]      │
│   └── run --peer → handle.sync.rpc(id, "x.y", input)     │
│                       │                                  │
└───────────────────────┼──────────────────────────────────┘
                        │ ws://... RPC msg 101
                        ↓
┌──────────────────────────────────────────────────────────┐
│ REMOTE PEER (same workspace code)                        │
│   rpc.dispatch("x.y", input)                             │
│     → dispatchAction(actions, "x.y", input)              │
│     → actions.x.y(input)                                 │
│   returns result via msg 101                             │
└──────────────────────────────────────────────────────────┘
```

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Schema source | Local config only | In practice, the CLI and remote peer run the same workspace package. Local types are authoritative. Drift shows as `ActionNotFound` at dispatch. |
| Sync connection | Reuse `entry.handle.sync` | Factory already attaches sync with URL, auth, awareness. The CLI is already a peer. |
| Remote discovery | Not built | Version skew is an edge case. If users hit it, add `__actions__.list` later as a debug tool. |
| Target matching | `--peer <target>` — clientId / `key=value` / bare string | No mandatory awareness contract. Always falls back to clientId. |
| Peer enumeration | Dynamic `console.table` over `awareness.getStates()` | No assumed schema. Columns are the union of keys across peers. |
| Device naming | Convention, not primitive | Apps that want `--peer myMacbook` declare `deviceName: type('string')` in awareness defs and publish on init. Four lines, no new helper. |
| Flag scope | Per-command (matches `--workspace`, `--dir`) | Not global. |

## Non-Goals

- **`list --peer`** — local `list` is authoritative. If the peer's tree differs, that's a version skew problem.
- **Remote discovery RPC** — out of v1. Add only if real users hit it.
- **New framework-injected actions** — no `__actions__.list`, no reserved namespace.
- **`attachDeviceName` primitive** — the convention is trivial enough to inline.
- **Direct peer-to-peer connection** — all RPC flows through the sync room's DO.
- **Cross-time data attribution** — apps that need stable `deviceId` for attribution roll their own on top (tab-manager already does).

## Identity Model

Three layers exist in the runtime; the CLI consumes them, no new abstractions:

| Layer | Stability | Readability | Source |
| --- | --- | --- | --- |
| `clientID` | Ephemeral (per connection) | Numeric | Yjs, always present |
| `deviceName` (convention) | Stable (persisted by app) | Readable, user-editable | App declares in awareness defs, publishes on init |
| `deviceId` (app-specific) | Stable across renames | Not readable (NanoID) | Apps add on top if needed (e.g. tab-manager's `devices` table) |

`--peer <target>` resolution walks: explicit numeric clientId → `key=value` match → bare value matched against any string awareness field → error.

## Convention (optional, inline)

Apps that want `epicenter run --peer myMacbook` ergonomics:

```ts
// epicenter.config.ts
const awareness = attachAwareness(ydoc, {
  ...yourDefs,
  deviceName: type('string'),
});

// On init (wherever the app boots):
const name = storage.get('deviceName') ?? generateDefaultName();
storage.set('deviceName', name);
awareness.setLocalField('deviceName', name);
```

No helper. No primitive. Just schema + four lines. Consistent with the existing typed awareness API.

## Implementation Plan

### Phase 1 — `peers` command

- [ ] **1** `packages/cli/src/util/match-peer.ts`: `findPeerClientId(awareness, target): number | undefined`. Resolution: numeric string → clientId; `k=v` → field match; bare value → first string field match.
- [ ] **2** `packages/cli/src/commands/peers.ts`: iterate entries (narrow with `-w`), await `whenReady`, render `awareness.getStates()` via `console.table`.
- [ ] **3** Register in `cli.ts` alongside `run` and `list`.
- [ ] **4** Unit tests for `findPeerClientId` (numeric, `k=v`, bare fallback, no match).

### Phase 2 — `--peer` flag on `run`

- [ ] **5** `packages/cli/src/util/peer-option.ts` following `workspaceOption`/`dirOption` pattern.
- [ ] **6** In `run.ts` handler, after `resolveEntry`:
  - If `--peer` set: await `entry.handle.whenReady`, resolve `targetClientId` via `findPeerClientId`, validate input against local schema as usual, call `entry.handle.sync.rpc(targetClientId, segments.join('.'), input)`, handle `Result` envelope.
  - Else: unchanged local path.
- [ ] **7** Self-targeting: if `--peer` resolves to own `awareness.clientID`, error with "use local invocation instead."
- [ ] **8** E2E tests: spawn two peers against the fixture, invoke cross-peer.

### Phase 3 — Document the convention

- [ ] **9** Add a short section to `packages/workspace/README.md` explaining the `deviceName` convention for CLI ergonomics. Link to `apps/tab-manager` as reference.

## CLI API Shape

```bash
# Enumeration
epicenter peers                        # all workspaces (or narrow with -w)
epicenter peers -w tabManager

# Remote invocation — action path identical to local (already unified)
epicenter run --peer myMacbook tabs.close --tab-ids 1 2 3
epicenter run --peer deviceName=myMacbook tabs.close ...     # explicit key
epicenter run --peer 42 tabs.close ...                        # clientId fallback
```

`list` stays local-only. `run` without `--peer` is unchanged.

## Edge Cases

1. **Peer offline** — `sync.rpc` returns `PeerOffline`. CLI prints to stderr, exits 1.
2. **Timeout** — default 5000ms. Add `--timeout` flag if needed.
3. **Ambiguous `--peer` match** — two peers match via different fields. Error with candidate list.
4. **Self-targeting** — error: "use local invocation."
5. **`ActionNotFound` on remote** — peer missing an action the local tree has (version skew). Error surfaces with the RPC error message — this is the diagnostic signal users need.
6. **Awareness not yet populated** — `whenReady` resolves after `sync.whenConnected`. May need explicit "first awareness received" event, or a small settle window. **Needs verification during implementation.**

## Success Criteria

- [ ] `epicenter peers` renders a dynamic table of connected peers per workspace.
- [ ] `epicenter run --peer <target> <path> [args]` invokes remotely; output is identical to local invocation.
- [ ] `--peer` works with clientId, `k=v`, and bare-string match.
- [ ] Local `run` and `list` performance unchanged when `--peer` is absent.
- [ ] An app can opt into `--peer myMacbook` ergonomics in four lines (awareness def + init publish).

## References

- `specs/20260423T010000-unify-dot-path-format.md` — prerequisite (shipped)
- `packages/sync/src/protocol.ts:449-621` — RPC wire protocol
- `packages/workspace/src/document/attach-sync.ts:779-840` — `sync.rpc` client
- `apps/api/src/base-sync-room.ts:368-442` — DO-side RPC routing
- `packages/workspace/src/shared/actions.ts:471-488` — receiver-side dispatch
- `packages/workspace/src/document/attach-awareness.ts` — typed awareness wrapper
- `apps/tab-manager/src/lib/device/device-id.ts` — example device identity pattern
