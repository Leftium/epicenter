# Cloudless Home Anchor Direction

**Date**: 2026-06-16
**Status**: Draft
**Owner**: Braden
**Builds on**: `20260614T120000-app-folder-as-root-and-jsrepo-blocks.md`, `20260615T120000-trusted-relay-and-collaborative-fields.md`, `docs/encryption.md`

## One Sentence

Epicenter keeps one app mount per folder, keeps app-global workspace ids for each signed-in user's corpus, and adds a native Iroh sidecar below the daemon so those same Yjs rooms can sync to a user-owned home anchor instead of Epicenter Cloud.

## Current Direction

```txt
app folder
  epicenter.config.ts      singular Mount, e.g. export default fuji()
  .epicenter/             local machine state
  entries/                read-only projection

daemon for that folder
  owns the app Y.Doc
  owns Yjs log persistence
  owns SQLite and Markdown materializers
  owns actions

transport
  hosted mode: WebSocket to Epicenter Cloud
  cloudless mode: local Rust/Iroh sidecar to home anchor

home anchor
  always-on trusted peer
  stores many Yjs rooms
  stays app-semantics-blind
```

The folder is the local mount/projection site. It is not automatically the remote corpus identity. For app-global products like Fuji, the workspace id can stay fixed per app and signed-in owner: `epicenter-fuji` means "this user's Fuji corpus." Two folders that both mount `fuji()` while signed in as the same owner are two local projections of the same corpus.

The mount name is a local label, not a routing namespace. Current CLI action addresses are bare action keys inside the one served mount, e.g. `epicenter run entries_update`. Cloudless sync must preserve that shape: one folder serves one mount, and transport routing happens below the daemon.

## Identity Rules

These identities must not be collapsed:

| Identity | Means | Same value implies | Collision risk |
| --- | --- | --- | --- |
| `ydoc.guid` / workspace id | Which data corpus or child doc | Sync the same data | Intentional when two replicas join the same room |
| Yjs `clientID` | Which CRDT actor produced operations | Same live writer | Dangerous if two live processes share it |
| `nodeId` | Which reachable runtime presence/dispatch targets | Same online node/process | Dangerous if two daemons share it |
| Iroh endpoint id | Which native peer to connect to | Same cryptographic network peer | Must be persisted per native peer |

The fixed workspace id is not the bug. The bug would be deriving daemon writer identity from a path or hardcoding daemon presence identity.

Old risky shape:

```ts
ydoc.clientID = hashYDocClientId(ctx.epicenterRoot);
nodeId: asNodeId(`${ctx.mount}-daemon`)
```

Two machines can share the same absolute path and mount name. They should still sync the same workspace, but they must not share the same Yjs `clientID` or daemon `nodeId`.

Current repo shape:

```txt
.epicenter/node.json
  epicenter.node.id: generated nodeId

attachMountInfrastructure(...)
  ydoc.clientID = hashYDocClientId(ctx.nodeId)
```

The node file is local machine state. It is ignored, not synced, and created once per app folder per machine. Because `nodeId` is random and persisted per root, two folders of the same app can intentionally sync the same corpus without sharing the same live actor identity.

## Transport Placement

Iroh belongs below the daemon, not inside app factories.

```txt
Fuji mount
  -> attachMountInfrastructure(...)
  -> sync transport adapter
       hosted: WebSocket
       cloudless: sidecar
  -> Yjs sync frames
```

The sidecar should carry existing `@epicenter/sync` frames, wrapped only with routing metadata:

```json
{ "type": "sync", "roomId": "epicenter-fuji", "frameBase64": "..." }
```

The sidecar must not learn Fuji tables, actions, materializers, child-doc layouts, or app schemas. It routes room bytes and reports connection status.

## Scope: App-Blind Custody Only

The home anchor here routes opaque room bytes and never learns app schemas, layouts, actions, or product semantics. The always-on device *also* runs per-app **actors** (observe synced docs, run inference, execute the app's actions as agent tools), but those are a separate, app-aware role: daemons that sit beside the anchor, never inside the Iroh sidecar. "Anchor" in this spec always means the app-blind role. The actor/agent layer is specified in `docs/adr/0012-an-always-on-actor-runs-app-semantics-beside-the-app-blind-anchor.md`, `docs/adr/0013-agent-conversations-are-durable-child-docs-driven-by-an-observing-actor.md`, and `specs/20260616T225034-always-on-actors-over-synced-docs.md`.

## Multiplexing Rule

Do not multiplex apps in `epicenter.config.ts`.

```txt
No:
  export default [fuji(), zhongwen()]

Yes:
  fuji/epicenter.config.ts      export default fuji()
  zhongwen/epicenter.config.ts  export default zhongwen()
```

Multiplexing belongs at the transport layer:

```txt
one local Rust sidecar
  room epicenter-fuji
  room epicenter-fuji.entries.content.<id>
  room epicenter-zhongwen
  room epicenter-zhongwen.conversations.messages.<id>
```

This preserves folder/process fault isolation while avoiding one Iroh endpoint per room.

## Topology

The default cloudless topology is still a star around the home anchor.

```txt
MacBook daemon -> local sidecar -> Iroh -> Mac Studio anchor
phone app      -> native sidecar -> Iroh -> Mac Studio anchor
desktop daemon -> local sidecar -> Iroh -> Mac Studio anchor
```

Peerwise Iroh or gossip can be an optimization later. It should not be the base model, because it does not answer the durability question: where does the update go when every other device is asleep?

## What The Spike Proved

Throwaway spike: `/Users/braden/Code/epicenter-anchor-experiment`.

- Iroh 1.0 can reach a home Mac Studio anchor from a MacBook on phone hotspot.
- The anchor can persist a `yrs` doc and keep a stable endpoint identity across restart.
- JS/Yjs update bytes are compatible with Rust/yrs for the tested document shape.
- A live JS/Yjs runtime can use a Rust sidecar to sync through Iroh while JS keeps app semantics.

What it did not prove:

- Real `@epicenter/sync` frame transport.
- Room multiplexing.
- Pairing, revocation, auth, packaging, supervision.
- Browser-direct networking.
- Production daemon-to-sidecar integration against the repo's current `nodeId` model.

## Recommended Next Slice

1. Keep the singular-mount collapse honest: remove or rename any stale multi-mount wording that contradicts one folder, one mount, bare action keys.
2. Make the sidecar carry real `@epicenter/sync` binary frames for one room.
3. Add sidecar room multiplexing.
4. Define pairing: how a daemon learns and trusts the home anchor's Iroh endpoint id.
5. Treat the app-blind anchor/sidecar and the app-aware actor (daemon) as separate roles with separate packaging. The sidecar multiplexes opaque rooms; the actor mounts an app workspace, observes its docs, and runs the app's actions as agent tools. Do not fold the actor into the sidecar. See ADR-0012.
6. Only then add product packaging and browser/native wrapper decisions.

## Grill Prompt

```md
We are reviewing Epicenter's cloudless home-anchor direction.

Current thesis:
- One app folder has one `epicenter.config.ts`.
- That config default-exports one `Mount`, not `Mount[]`.
- The folder is a local mount/projection site.
- The workspace id / `ydoc.guid` is the remote corpus identity. Same id means same synced data.
- Yjs `clientID` and daemon `nodeId` are local actor identities and must be unique per live daemon/node.
- Iroh belongs below the daemon as an alternate transport, not inside app factories.
- A shared Rust sidecar can multiplex many Yjs rooms to one home anchor.
- The home anchor is the always-on trusted peer for cloudless custody.

Please review whether this direction is coherent against the repo. Focus on:

1. Whether fixed app workspace ids are correct for app-global corpora like Fuji.
2. Whether the current daemon identity model is sufficient: `.epicenter/node.json` stores `nodeId`, and Yjs `clientID` is derived from `ctx.nodeId`.
3. Whether daemon node identity belongs under the app root's `.epicenter/` directory or platform user data.
4. Whether bare action keys remain correct now that config is singular.
5. Whether any product semantics accidentally move into Rust/Iroh.
6. Whether multiplexing belongs only in the sidecar/anchor, not config.
7. Whether star topology around the anchor should remain the default over peerwise gossip.
8. The smallest implementation slice that proves this without overbuilding.

Relevant files:
- specs/20260616T185740-cloudless-home-anchor-direction.md
- specs/20260614T120000-app-folder-as-root-and-jsrepo-blocks.md
- specs/20260615T120000-trusted-relay-and-collaborative-fields.md
- docs/encryption.md
- packages/workspace/src/daemon/attach-mount-infrastructure.ts
- packages/workspace/src/config/daemon-node-id.ts
- packages/workspace/src/shared/client-id.ts
- packages/workspace/src/document/node-id.ts
- packages/workspace/src/document/internal/sync-supervisor.ts
- packages/workspace/src/config/load-epicenter-config.ts
```
