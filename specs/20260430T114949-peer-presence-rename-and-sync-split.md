# Peer Presence Rename And Sync Split

**Date**: 2026-04-30
**Status**: Draft
**Author**: AI-assisted
**Related**: `specs/20260430T103959-split-attach-sync-into-transport-presence-rpc.md`, `specs/20260430T120000-cli-naming-decision.md`

## Overview

This spec combines three related breaking changes that should land together: standard awareness becomes peer presence, `attachSync` splits presence and RPC into explicit sibling attachments, and public action exposure moves back to an explicit `actions` registry. `attachSync` keeps Y.Doc synchronization, `sync.attachPresence({ peer })` owns routable peer identity, and `sync.attachRpc({ actions })` owns the registry that can be called over the wire.

One sentence:

```txt
A workspace exposes an explicit action registry, then peer presence maps stable peer ids to live Yjs clientIDs so RPC can call that registry across runtimes.
```

## Motivation

### Current State

`attachSync` currently owns sync, presence, and RPC in one return object:

```ts
const sync = attachSync(doc, {
	url,
	waitFor: idb,
	device: {
		id: getOrCreateDeviceId(localStorage),
		name: 'Fuji',
		platform: 'web',
	},
	actions,
});

const peers = sync.peers();
const found = sync.find('macbook-pro');
const remote = createRemoteActions<typeof tabManager>(sync, 'macbook-pro');
```

Current action discovery also walks entire workspace bundles in some places:

```ts
const entries = [...walkActions(workspace)];
const action = resolveActionPath(workspace, actionPath);
const tools = actionsToAiTools(workspace);
```

The standard awareness state is:

```ts
{
	device: {
		id: 'macbook-pro',
		name: 'Braden MacBook',
		platform: 'tauri',
	},
}
```

This creates five problems:

1. **The noun is too narrow**: `device` works for a laptop, but the runtime can also be a browser tab cluster, Chrome extension background worker, CLI daemon, Tauri app, or future worker process.
2. **The word collides with app domains**: Tab Manager has an app-level `Device` table. Whispering already uses `Device` for audio hardware. The sync layer means "live routable runtime", not every domain object called a device.
3. **The type lies**: `SyncAttachment` exposes `peers()`, `find()`, `observe()`, and `rpc()` even when the caller did not configure presence or RPC.
4. **The file boundary is muddy**: `standard-awareness-defs.ts` sounds like general awareness, but it defines the standard Epicenter peer identity used by sync.
5. **Action exposure is implicit**: walking the whole workspace makes CLI paths, AI tool names, remote manifests, and inbound RPC depend on object layout. Moving actions under an `actions` key can silently change `tabs.close` into `actions.tabs.close`.

### Desired State

The app composes the three jobs explicitly:

```ts
const actions = defineActions({
	tabs: {
		close: defineMutation({ ... }),
		list: defineQuery({ ... }),
	},
});

const sync = attachSync(doc.ydoc, {
	url,
	waitFor: idb,
	getToken,
});

const presence = sync.attachPresence({
	peer: {
		id: getOrCreateInstallationId(localStorage),
		name: 'Fuji',
		runtime: 'web',
	},
});

const rpc = sync.attachRpc({
	actions,
});

const remote = peer<typeof actions>({ presence, rpc }, 'macbook-pro');
const manifest = await describePeer({ presence, rpc }, 'macbook-pro');
```

The standard awareness state becomes namespaced and versioned:

```ts
{
	epicenter: {
		v: 1,
		peer: {
			id: 'macbook-pro',
			name: 'Braden MacBook',
			runtime: 'tauri',
		},
	},
}
```

## Research Findings

### Yjs Awareness Model

Yjs awareness is ephemeral JSON state keyed by `clientID`. The `clientID` is a runtime address, not a durable identity. A fresh `Y.Doc` gets a new client id, and awareness states disappear when peers disconnect or time out.

That means awareness is the correct place for the live routing map:

```txt
stable identity       Yjs awareness       volatile address       RPC
---------------       -------------       ----------------       ---
peer.id          ->   state.peer      ->   clientID          ->   rpc(clientID, action)
```

Awareness is not the correct place for full capabilities, schemas, permissions, or durable registry data. Those belong in RPC or persistent CRDT data.

### Current Repo Surface

The current public surface is split across these concepts:

| Concept | Current name | Problem |
| --- | --- | --- |
| Stable live runtime identity | `DeviceDescriptor` | Too tied to physical device language |
| Awareness schema file | `standard-awareness-defs.ts` | Sounds generic, but it is Epicenter peer presence |
| Local config | `device` | Hides that passing it enables peer discovery |
| Lookup | `sync.find(deviceId)` | Too generic and tied to the old noun |
| Snapshot | `sync.peers()` | Correct noun, but it lives on sync even without presence |
| Remote proxy | `createRemoteActions(sync, deviceId)` | Mechanism-oriented name and old target noun |
| Discovery | `describeRemoteActions(sync, deviceId)` | Same issue |

### Related Spec

`specs/20260430T103959-split-attach-sync-into-transport-presence-rpc.md` already argues for splitting `attachSync` into sync, presence, and RPC attachments. This spec keeps that direction but changes the vocabulary before the split lands, so the extracted modules do not preserve the old device naming.

### Action Surface From `3009b6ca4`

Commit `3009b6ca4` made one important improvement: action discovery, AI tool conversion, RPC type inference, and remote manifests should share one traversal contract. That part should stay. The mistake was letting the workspace bundle itself become the public root for every action path.

The new rule is:

```txt
Implementation primitive:
  walkActions(source) may keep the same safe plain-object traversal internally.

Public exposure boundary:
  CLI, AI tools, RPC, and remote manifests use workspace.actions.
```

That keeps the useful flattening work while making path roots deliberate. Public action paths are always relative to the registry:

```txt
tabs.close
files.read
entries.create
```

They should not include the implementation grouping key:

```txt
actions.tabs.close
```

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Standard concept name | `peer` | The runtime is routable and online. It might not be a physical device. |
| Stable id name | `peer.id` in presence, `installationId` in storage helpers | Presence needs a short routing key. Storage should say where the id comes from. |
| Runtime platform name | `runtime` | `platform` is too broad in this repo and already appears in many unrelated contexts. |
| Awareness namespace | `epicenter` | Avoids claiming `peer` or `device` as a Yjs-wide convention. Leaves app fields like `cursor` clean. |
| Awareness version | `v: 1` | Gives us a future migration hook without changing the whole state shape. |
| `attachSync` name | Keep | It synchronizes a Y.Doc. `attachTransport` would describe an implementation detail. |
| Presence ownership | `sync.attachPresence({ peer })` | Presence is a sub-protocol riding on the sync connection. It should not be a top-level attachment with a hidden dependency. |
| RPC ownership | `sync.attachRpc({ actions })` | RPC registers message handlers and pending cleanup. It is side-effectful, so `attach*` is the right verb. |
| Action exposure root | `workspace.actions` | The public callable surface should be a named registry, not inferred from bundle layout. |
| Action registry helper | `defineActions(tree)` | Identity helper that validates keys, preserves inference, and gives authors one obvious place to declare the public surface. |
| Bundle walking | Internal or debug utility only | Useful traversal implementation, but not the public CLI, AI, or RPC contract. |
| CLI and AI paths | Registry-relative paths | Tool names and CLI paths should be stable across unrelated workspace bundle refactors. |
| Generic awareness | Keep separate | Custom cursors, selections, and typing state should still use `attachAwareness`. Standard peer presence is a specific convention. |
| Compatibility aliases | No aliases in the clean break | Aliases keep the old vocabulary alive and make docs worse. |

## Architecture

### Current Shape

```txt
+------------------------------+
| attachSync(doc, config)      |
|                              |
| config.device                |
| config.awareness             |
| config.actions               |
|                              |
| returns:                     |
|   status                     |
|   peers()                    |
|   find(deviceId)             |
|   observe()                  |
|   rpc(clientId, action)      |
|   raw.awareness              |
|                              |
| CLI and AI may walk the      |
| whole workspace bundle       |
+------------------------------+
        |
        +--> Y.Doc sync supervisor
        +--> awareness with { device }
        +--> RPC dispatch and system.describe
```

### Target Shape

```txt
+------------------------------+
| attachSync(doc, config)      |
|                              |
| owns:                        |
|   WebSocket supervisor       |
|   Y.Doc sync protocol        |
|   lifecycle status           |
|   frame dispatch table       |
+------------------------------+
        |
        +-------------------------------+
        |                               |
        v                               v
+------------------------------+  +------------------------------+
| sync.attachPresence({ peer }) |  | sync.attachRpc({ actions })  |
|                              |  |                              |
| owns:                        |  | owns:                        |
|   Yjs Awareness              |  |   pending RPC requests       |
|   epicenter.peer state       |  |   action dispatch            |
|   peers()                    |  |   system.describe            |
|   resolve(peerId)            |  |   rpc(clientID, action)      |
|   subscribe()                |  |                              |
+------------------------------+  +------------------------------+
        |                               |
        +---------------+---------------+
                        |
                        v
              peer({ presence, rpc }, peerId)
```

### Action Exposure Boundary

```txt
+------------------------------+
| workspace bundle             |
|                              |
| ydoc                         |
| tables                       |
| idb                          |
| sync                         |
| presence                     |
| rpc                          |
| actions                      |
|   tabs.close                 |
|   files.read                 |
+------------------------------+
        |
        +--> CLI list/run: describeActions(workspace.actions)
        +--> AI tools: actionsToAiTools(workspace.actions)
        +--> RPC: sync.attachRpc({ actions: workspace.actions })
        +--> Types: InferSyncRpcMap<typeof workspace.actions>
```

### Addressing Flow

```txt
1. App boots
   storage -> getOrCreateInstallationId() -> peer.id

2. Presence attaches
   sync.attachPresence({ peer }) -> awareness local state

3. Another runtime calls a peer
   peer({ presence, rpc }, peerId)
     -> presence.resolve(peerId)
     -> ResolvedPeer { clientId, state }
     -> rpc.rpc(clientId, action, input)

4. Peer leaves
   awareness removes clientId
     -> pending peer calls return PeerLeft
```

## Proposed API

### Action Registry

```ts
const actions = defineActions({
	tabs: {
		close: defineMutation({ ... }),
		list: defineQuery({ ... }),
	},
});

type TabManagerActions = typeof actions;
type TabManagerRpc = InferSyncRpcMap<typeof actions>;
```

`defineActions` should be an identity helper at runtime. Its job is to preserve inference, validate path keys once, and make the public boundary visible at the call site.

The action utilities should target the registry:

```ts
describeActions(workspace.actions);
walkActions(workspace.actions);
resolveActionPath(workspace.actions, 'tabs.close');
actionsToAiTools(workspace.actions);
```

### Peer Presence Types

```ts
export const PeerRuntime = type('"web" | "tauri" | "chrome-extension" | "node"');
export type PeerRuntime = typeof PeerRuntime.infer;

export const PeerIdentity = type({
	id: 'string',
	name: 'string',
	runtime: PeerRuntime,
	'app?': 'string',
});
export type PeerIdentity = typeof PeerIdentity.infer;

export type PeerIdentityInput<TId extends string = string> = {
	id: TId;
	name: string;
	runtime: PeerRuntime;
	app?: string;
};

export const EpicenterPresenceState = type({
	epicenter: {
		v: '1',
		peer: PeerIdentity,
	},
});
export type PeerPresenceState = typeof EpicenterPresenceState.infer;

export type ResolvedPeer = {
	clientId: number;
	state: PeerPresenceState;
};
```

### Sync Attachment

```ts
const sync = attachSync(ydoc, {
	url,
	waitFor,
	getToken,
});

const presence = sync.attachPresence({
	peer,
});

const rpc = sync.attachRpc({
	actions,
});
```

### Presence Attachment

```ts
type PresenceAttachment = {
	peers(): Map<number, PeerPresenceState>;
	resolve(peerId: string): ResolvedPeer | undefined;
	subscribe(callback: () => void): () => void;
	raw: { awareness: YAwareness };
};
```

### RPC Attachment

```ts
type RpcAttachment = {
	rpc<TMap extends RpcActionMap = DefaultRpcMap, TAction extends string & keyof TMap = string & keyof TMap>(
		target: number,
		action: TAction,
		input?: TMap[TAction]['input'],
		options?: RemoteCallOptions,
	): Promise<Result<TMap[TAction]['output'], RpcError>>;
};
```

### Remote Peer Helpers

```ts
const remote = peer<TabManagerActions>({ presence, rpc }, peerId);
const result = await remote.tabs.close({ tabIds: [1] });

const manifest = await describePeer({ presence, rpc }, peerId);
```

Normal app bundles can hide the pair:

```ts
return {
	...doc,
	sync,
	presence,
	rpc,
	peer: <T>(peerId: string) => peer<T>({ presence, rpc }, peerId),
	describePeer: (peerId: string) => describePeer({ presence, rpc }, peerId),
};
```

## Rename Map

| Current | Target | Notes |
| --- | --- | --- |
| `standard-awareness-defs.ts` | `peer-presence.ts` | File should say what convention it owns. |
| `Platform` | `PeerRuntime` | Avoid broad platform naming. |
| `PeerDevice` | `PeerIdentity` | This is identity for a live peer. |
| `DeviceDescriptor` | `PeerIdentityInput` | Generic input type for branded ids. |
| `PeerAwarenessState` | `PeerPresenceState` | Presence is the concept, awareness is the Yjs mechanism. |
| `FoundPeer` | `ResolvedPeer` | Resolution maps peer id to client id. |
| `standardAwarenessDefs` | `peerPresenceDefs` | Keep private unless a real public custom composition appears. |
| `config.device` | `sync.attachPresence({ peer })` | Presence becomes explicit. |
| `state.device` | `state.epicenter.peer` | Namespaced and versioned awareness state. |
| `sync.peers()` | `presence.peers()` | No more no-op method on sync. |
| `sync.find(deviceId)` | `presence.resolve(peerId)` | More precise verb and target noun. |
| `sync.observe()` | `presence.subscribe()` | Avoid generic observe on a multi-concern object. |
| `createRemoteActions` | `peer` | App-facing concept. |
| `describeRemoteActions` | `describePeer` | Same target vocabulary. |
| `getOrCreateDeviceId` | `getOrCreateInstallationId` | Storage helper names the durable source. |
| `deviceId` call-site names | `peerId` or `installationId` | Use `peerId` for routing, `installationId` for storage. |
| `walkActions(workspace)` | `walkActions(workspace.actions)` | Public path root becomes explicit. |
| `describeActions(workspace)` | `describeActions(workspace.actions)` | CLI and manifests use registry-relative paths. |
| `actionsToAiTools(workspace)` | `actionsToAiTools(workspace.actions)` | AI tool names should not include implementation grouping. |
| `InferSyncRpcMap<typeof workspace>` | `InferSyncRpcMap<typeof workspace.actions>` | The type contract matches the runtime root. |

## Files Likely Touched

| File | Change |
| --- | --- |
| `packages/workspace/src/shared/actions.ts` | Add `defineActions`; reframe `Actions` as the public registry shape; keep canonical traversal but target registry roots in public docs. |
| `packages/workspace/src/ai/tool-bridge.ts` | Change examples and call sites back to action registries. Keep one traversal path. |
| `packages/workspace/src/rpc/types.ts` | Update examples and tests to infer RPC maps from `typeof actions`. |
| `packages/workspace/src/document/attach-sync.ts` | Remove presence and RPC ownership from base return. Add `attachPresence`, `attachRpc`, and internal frame registration surface. |
| `packages/workspace/src/document/peer-presence.ts` | New standard peer presence definitions and resolver helpers. Replaces `standard-awareness-defs.ts`. |
| `packages/workspace/src/document/attach-presence.ts` | New presence attachment implementation. Owns awareness send and receive through sync. |
| `packages/workspace/src/document/attach-rpc.ts` | New RPC attachment implementation. Owns pending requests, request handling, response handling, and `system.describe`. |
| `packages/workspace/src/rpc/peer.ts` | Rename remote helpers and depend on `{ presence, rpc }`. |
| `packages/workspace/src/shared/device-id.ts` | Rename storage helpers to installation id helpers. |
| `packages/workspace/src/index.ts` | Update public exports. Remove old device-based names. |
| `packages/workspace/src/document/attach-sync.test.ts` | Keep supervisor and sync protocol tests. Move presence and RPC tests out. |
| `packages/workspace/src/document/attach-presence.test.ts` | New tests for namespaced awareness state and peer resolution. |
| `packages/workspace/src/document/attach-rpc.test.ts` | New tests for RPC frame handling and system describe. |
| `packages/workspace/src/rpc/peer.test.ts` | Update mocks from one sync object to `{ presence, rpc }`. |
| `packages/workspace/src/ai/tool-bridge.test.ts` | Assert tool names are registry-relative. |
| `packages/cli/src/daemon/run-handler.ts` | Resolve actions from `workspace.actions`, not the whole workspace. |
| `packages/cli/src/daemon/app.ts` | Describe `workspace.actions` for `/list`; read `entry.workspace.presence.peers()` for `/peers`. |
| `apps/fuji/src/lib/fuji/client.ts` | Rename id helper and `device` construction. |
| `apps/fuji/src/lib/fuji/browser.ts` | Attach sync, presence, and RPC separately. |
| `apps/honeycrisp/src/lib/honeycrisp/client.ts` | Same pattern. |
| `apps/honeycrisp/src/lib/honeycrisp/browser.ts` | Same pattern. |
| `apps/opensidian/src/lib/opensidian/client.ts` | Same pattern. |
| `apps/opensidian/src/lib/opensidian/browser.ts` | Same pattern, including explicit `actions` RPC attachment. |
| `apps/tab-manager/src/lib/tab-manager/client.ts` | Rename generated descriptor to peer identity. Keep app table ids branded. |
| `apps/tab-manager/src/lib/tab-manager/extension.ts` | Attach sync, presence, and RPC separately. |
| `packages/cli/src/load-config.ts` | Update public workspace entry shape and type aliases. |
| `packages/cli/src/util/peer-wait.ts` | Resolve via presence, not sync. |
| `packages/workspace/SYNC_ARCHITECTURE.md` | Rewrite diagrams around sync, presence, and RPC. |

## Implementation Plan

### Phase 0: Freeze The Target Vocabulary And Roots

- [ ] **0.1** Confirm the one-sentence test.
- [ ] **0.2** Confirm the awareness wire shape: `state.epicenter.v` and `state.epicenter.peer`.
- [ ] **0.3** Confirm `runtime` vs `platform`.
- [ ] **0.4** Confirm storage helper naming: `getOrCreateInstallationId`.
- [ ] **0.5** Confirm `workspace.actions` is the public action path root for CLI, AI, RPC, manifests, and type inference.
- [ ] **0.6** Confirm app bundle helpers are optional ergonomics, not the canonical public contract.

### Phase 1: Make Action Exposure Explicit

- [ ] **1.1** Add `defineActions(tree)` in `packages/workspace/src/shared/actions.ts`.
- [ ] **1.2** Validate action path keys at registry definition time where practical. Keep `walkActions` validation as a safety net.
- [ ] **1.3** Reframe `Actions` as a public registry type again instead of a non-load-bearing suggestion.
- [ ] **1.4** Update `describeActions`, `walkActions`, `resolveActionPath`, `actionsToAiTools`, `InferSyncRpcMap`, and remote proxy tests so examples use explicit registries.
- [ ] **1.5** Keep the plain-object traversal implementation, but stop documenting full workspace bundle walking as the public path contract.
- [ ] **1.6** Add regression tests proving `actionsToAiTools(workspace.actions)` produces `tabs_close`, not `actions_tabs_close`.

### Phase 2: Add New Peer Presence Definitions

- [ ] **2.1** Create `packages/workspace/src/document/peer-presence.ts`.
- [ ] **2.2** Define `PeerRuntime`, `PeerIdentity`, `PeerIdentityInput`, `PeerPresenceState`, and `ResolvedPeer`.
- [ ] **2.3** Add private `peerPresenceDefs` for `createAwareness`.
- [ ] **2.4** Add helper functions only if they remove real duplication, for example `resolvePeer(peers, peerId)`.
- [ ] **2.5** Export new public types from `packages/workspace/src/index.ts`.
- [ ] **2.6** Keep old definitions untouched until call sites have a migration path.

### Phase 3: Extract Presence From Sync

- [ ] **3.1** Add `sync.attachPresence({ peer })`.
- [ ] **3.2** Move awareness construction and local publication out of `attach-sync.ts`.
- [ ] **3.3** Register awareness frame handling through sync's internal frame dispatch surface.
- [ ] **3.4** Send local awareness updates through sync's internal send surface.
- [ ] **3.5** Move `peers()`, `find()`, and `observe()` behavior to `PresenceAttachment` as `peers()`, `resolve()`, and `subscribe()`.
- [ ] **3.6** Add tests for malformed awareness states being ignored.
- [ ] **3.7** Add tests for `state.epicenter.peer` publication before `attachPresence` returns.

### Phase 4: Extract RPC From Sync

- [ ] **4.1** Add `sync.attachRpc({ actions })`.
- [ ] **4.2** Require an explicit action registry for inbound action exposure. Do not default to walking the whole workspace bundle.
- [ ] **4.3** Move pending request state and request id generation out of `attach-sync.ts`.
- [ ] **4.4** Move inbound RPC request handling and action invocation out of `attach-sync.ts`.
- [ ] **4.5** Move `system.describe` injection into the RPC attachment.
- [ ] **4.6** Preserve disconnected pending request cleanup.
- [ ] **4.7** Add tests for RPC without presence by targeting raw client id.

### Phase 5: Rename Remote Peer Helpers

- [ ] **5.1** Rename `createRemoteActions` to `peer`.
- [ ] **5.2** Rename `describeRemoteActions` to `describePeer`.
- [ ] **5.3** Change helper input from `SyncAttachment` to `{ presence, rpc }`.
- [ ] **5.4** Preserve peer-left race behavior in the remote peer helper by observing presence changes.
- [ ] **5.5** Update tests to mock only the smaller presence and RPC surfaces.
- [ ] **5.6** Remove old helper exports after app and CLI migrations compile.

### Phase 6: Migrate Workspace Apps

- [ ] **6.1** Ensure each synced workspace returns an explicit `actions` registry where it exposes actions.
- [ ] **6.2** Rename app boot descriptors from `device` to `peer`.
- [ ] **6.3** Rename storage helper usage from `getOrCreateDeviceId` to `getOrCreateInstallationId`.
- [ ] **6.4** Update Fuji browser factory to attach sync, presence, and RPC separately.
- [ ] **6.5** Update Honeycrisp browser factory the same way.
- [ ] **6.6** Update Opensidian browser factory the same way, including explicit actions passed to RPC.
- [ ] **6.7** Update Tab Manager extension factory. Be careful around the app-level `Device` table and branded `DeviceId`.
- [ ] **6.8** Update AI tool exports to call `actionsToAiTools(workspace.actions)`.
- [ ] **6.9** Keep content docs sync-only unless they need peer presence.

### Phase 7: Migrate CLI

- [ ] **7.1** Update workspace entry typing to require `[Symbol.dispose]` and optionally read `actions`, `presence`, and `rpc`.
- [ ] **7.2** Update `/list` to call `describeActions(workspace.actions ?? {})`.
- [ ] **7.3** Update local `/run` to call `resolveActionPath(workspace.actions ?? {}, actionPath)`.
- [ ] **7.4** Update `/peers` to return `peer` instead of `device`.
- [ ] **7.5** Update peer waiting and `--peer` resolution to call `presence.resolve(peerId)`.
- [ ] **7.6** Update remote `/run --peer` to dispatch through `workspace.rpc.rpc(...)`.
- [ ] **7.7** Update CLI output labels to use `peerId`. Clean break recommendation: do not keep `deviceId` in new output.
- [ ] **7.8** Update CLI tests and snapshots.

### Phase 8: Delete Old Vocabulary And Implicit Surfaces

- [ ] **8.1** Delete `standard-awareness-defs.ts`.
- [ ] **8.2** Delete old exports: `DeviceDescriptor`, `PeerDevice`, `PeerAwarenessState`, `FoundPeer`, and `Platform`.
- [ ] **8.3** Delete old sync methods: `sync.peers`, `sync.find`, `sync.observe`, and `sync.rpc`.
- [ ] **8.4** Delete old helper exports: `createRemoteActions`, `describeRemoteActions`, and `getOrCreateDeviceId`.
- [ ] **8.5** Remove public docs that recommend `walkActions(workspace)` or `actionsToAiTools(workspace)`.
- [ ] **8.6** Run `rg "deviceId|DeviceDescriptor|PeerDevice|standardAwarenessDefs|createRemoteActions|describeRemoteActions|sync\\.find|sync\\.peers|sync\\.observe|actionsToAiTools\\([^)]*workspace|describeActions\\(workspace|walkActions\\(workspace|resolveActionPath\\(workspace"` and handle every remaining hit intentionally.

### Phase 9: Documentation And Verification

- [ ] **9.1** Update `packages/workspace/SYNC_ARCHITECTURE.md`.
- [ ] **9.2** Update `packages/workspace/README.md` examples.
- [ ] **9.3** Update CLI docs and examples.
- [ ] **9.4** Update `packages/ai/README.md` so AI tools are built from registries.
- [ ] **9.5** Run focused workspace tests.
- [ ] **9.6** Run CLI tests.
- [ ] **9.7** Run monorepo typecheck.

## Edge Cases

### Same Installation In Multiple Tabs

Multiple tabs may share one stored installation id. Before cross-tab leader election, this can publish multiple peers with the same `peer.id`.

Expected behavior for this rename:

1. `presence.resolve(peerId)` sorts client ids ascending.
2. It returns the first matching peer.
3. Remote calls remain valid because same-installation runtimes are intended to be interchangeable.

Future leader election can reduce duplicate presence, but this rename does not need to solve it.

### RPC Without Presence

RPC can target a raw Yjs client id and does not require presence. The `peer()` helper requires both presence and RPC because it resolves a stable peer id to a client id.

Expected behavior:

```ts
await rpc.rpc(clientId, 'tabs.close', input);
peer({ presence, rpc }, peerId);
```

### Presence Without RPC

A read-only viewer may want to show online peers without invoking actions.

Expected behavior:

```ts
const presence = sync.attachPresence({ peer });
presence.peers();
```

No RPC attachment is required.

### Custom Awareness Fields

Apps may still use generic `attachAwareness` for cursors, selections, and typing indicators. Standard peer presence should not absorb those fields.

Expected behavior:

```ts
const editorAwareness = attachAwareness(ydoc, {
	cursor: Cursor,
	selection: Selection,
}, initial);
```

Standard peer presence remains separate:

```ts
const presence = sync.attachPresence({ peer });
```

### Malformed Peer State

A peer can publish malformed awareness state. Presence must validate before returning peer states.

Expected behavior:

1. Malformed `epicenter.peer` state is dropped from `presence.peers()`.
2. `presence.resolve(peerId)` ignores malformed states.
3. A warning can be logged through the configured logger.

### Old And New Peers In The Same Room

During a clean breaking migration, mixed old and new clients may temporarily share a room if deployed inconsistently.

Recommendation:

1. Treat old `{ device }` states as invisible to the new presence attachment.
2. Do not add compatibility reads unless rollout demands it.
3. If compatibility is required, add it as a temporary explicit migration branch with a deletion task.

### Registry Root Versus Bundle Layout

Workspace bundles can still contain infrastructure fields like `ydoc`, `tables`, `idb`, `sync`, `presence`, and `rpc`. Those fields must not affect public action paths.

Expected behavior:

```ts
describeActions(workspace.actions);
actionsToAiTools(workspace.actions);
resolveActionPath(workspace.actions, 'tabs.close');
```

Do not expose:

```ts
actions.tabs.close
```

unless the registry itself intentionally contains an `actions` namespace.

### Workspace Without Actions

Some workspace entries may expose sync and presence but no callable actions.

Expected behavior:

1. `/list` returns an empty manifest.
2. Local `/run` reports an unknown action with no crash.
3. `sync.attachRpc({ actions })` is only called when the workspace wants inbound RPC actions.
4. Peer listing still works when presence exists.

## Open Questions

1. **Should the awareness namespace be `epicenter` or `$epicenter`?**
   - Options: `epicenter`, `$epicenter`, `peer`.
   - Recommendation: `epicenter`. It is readable, stable, and avoids punctuation in ordinary data.

2. **Should `app` be required in `PeerIdentity`?**
   - Options: required `app`, optional `app`, no `app`.
   - Recommendation: optional. The routing identity does not require the app name, but CLI listings may benefit from it.

3. **Should the storage helper return `InstallationId` or `PeerId`?**
   - Options: `InstallationId`, `PeerId`, branded generic only.
   - Recommendation: use `getOrCreateInstallationId` for storage and pass it as `peer.id`. The same value can be branded by apps.

4. **Should CLI flags change from `--peer <id>` to anything else?**
   - Options: keep `--peer`, use `--peer-id`, keep old `--device`.
   - Recommendation: keep `--peer <id>`. It already matches the target concept.

5. **Should `PresenceAttachment.subscribe` pass change details?**
   - Options: `callback()`, `callback(changes)`, async event stream.
   - Recommendation: keep `callback()` for the first pass unless current callers need change details. The snapshot API is simpler and enough for UI refresh.

## Success Criteria

- [ ] `attachSync` no longer exposes peer or RPC methods directly.
- [ ] Standard peer presence publishes `state.epicenter.peer`, not `state.device`.
- [ ] Public workspace exports use `PeerIdentity`, `PeerIdentityInput`, `PeerPresenceState`, `ResolvedPeer`, and `PeerRuntime`.
- [ ] Public action exposure uses explicit `workspace.actions` registries.
- [ ] `defineActions` exists and preserves local handler inference.
- [ ] CLI list/run and AI tools use registry-relative paths.
- [ ] Apps pass `peer` into `sync.attachPresence({ peer })`.
- [ ] Apps pass explicit `actions` into `sync.attachRpc({ actions })` when they expose RPC.
- [ ] Remote calls use `peer({ presence, rpc }, peerId)` or app bundle helpers.
- [ ] CLI peer listing and peer targeting use peer vocabulary.
- [ ] No public docs recommend full-bundle action walking for CLI, AI, or RPC exposure.
- [ ] No old public names remain unless explicitly documented as temporary compatibility.
- [ ] Tests cover sync-only, presence-only, RPC-only, and presence plus RPC compositions.
- [ ] `bun test packages/workspace/src/document` passes.
- [ ] `bun test packages/workspace/src/rpc` passes.
- [ ] `bun test packages/cli` passes.
- [ ] Monorepo typecheck passes.

## References

- `packages/workspace/src/document/attach-sync.ts`: current combined sync, presence, and RPC implementation.
- `packages/workspace/src/document/standard-awareness-defs.ts`: current device presence definitions to replace.
- `packages/workspace/src/document/attach-awareness.ts`: generic typed awareness wrapper to reuse.
- `packages/workspace/src/shared/actions.ts`: action registry and canonical traversal implementation.
- `packages/workspace/src/ai/tool-bridge.ts`: AI tool conversion should take explicit registries.
- `packages/workspace/src/rpc/types.ts`: RPC type maps should infer from explicit registries.
- `packages/workspace/src/rpc/remote-actions.ts`: current remote action helper to rename and narrow.
- `packages/workspace/src/shared/device-id.ts`: current persistent id helper to rename.
- `packages/workspace/src/document/attach-sync.test.ts`: current presence and RPC tests to split.
- `packages/workspace/src/document/system-describe.test.ts`: current `system.describe` and no-manifest-in-awareness tests.
- `packages/workspace/src/rpc/remote-actions.test.ts`: current remote helper tests.
- `apps/fuji/src/lib/fuji/browser.ts`: app migration pattern.
- `apps/honeycrisp/src/lib/honeycrisp/browser.ts`: app migration pattern.
- `apps/opensidian/src/lib/opensidian/browser.ts`: app migration pattern with explicit actions.
- `apps/tab-manager/src/lib/tab-manager/extension.ts`: app migration pattern with branded app-level device ids.
- `packages/cli/src/daemon/app.ts`: CLI peer listing consumer.
- `packages/cli/src/util/peer-wait.ts`: CLI peer resolution consumer.
- `specs/20260430T103959-split-attach-sync-into-transport-presence-rpc.md`: previous split proposal that this spec refines.

## Review

Not implemented yet. This spec is ready for review before execution.
