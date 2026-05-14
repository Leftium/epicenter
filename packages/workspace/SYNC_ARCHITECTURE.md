# Multi-Device Sync Architecture

Epicenter replicates a `Y.Doc` across many devices over WebSocket. Any device with a filesystem can run a sync server; browser clients and other servers connect to it. Yjs's CRDT semantics keep every replica eventually consistent, regardless of provider count or message order.

This document describes the runtime: the two public primitives (`openCollaboration` and `attachYjsSync`), what they do at construction, and how the underlying wire is organized.

## Core concepts

### Sync nodes

A **sync node** is any device running a server with the Epicenter sync plugin. Sync nodes:

- Hold a `Y.Doc` instance in memory
- Accept WebSocket connections from browsers and other servers
- Broadcast updates to all connected clients
- Can connect to OTHER sync nodes as a client (server-to-server sync)

### Multi-provider architecture

A `Y.Doc` can be wired to multiple sync nodes simultaneously. Each provider connects to a different node; CRDT updates merge automatically:

```ts
const ydoc = new Y.Doc({ guid: 'epicenter.blog' });

attachYjsSync(ydoc, { url: 'ws://desktop.tailnet:3913/rooms/blog' });
attachYjsSync(ydoc, { url: 'ws://laptop.tailnet:3913/rooms/blog' });
attachYjsSync(ydoc, { url: 'wss://sync.myapp.com/rooms/blog' });
```

### Why this works

- **CRDTs**: Yjs uses Conflict-free Replicated Data Types; updates merge regardless of order
- **Vector clocks**: Each update has a unique ID; the same update received twice is applied once
- **Eventual consistency**: All `Y.Doc` instances converge to identical state, guaranteed

## Network topology

### Example setup (3 devices + cloud)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SYNC NODE NETWORK                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   PHONE                    LAPTOP                     DESKTOP               │
│   ┌──────────┐            ┌──────────┐              ┌──────────┐            │
│   │ Browser  │            │ Browser  │              │ Browser  │            │
│   │ Y.Doc    │            │ Y.Doc    │              │ Y.Doc    │            │
│   └────┬─────┘            └────┬─────┘              └────┬─────┘            │
│        │                       │                         │                  │
│   (no server)             ┌────▼─────┐              ┌────▼─────┐            │
│        │                  │ Server   │◄────────────►│ Server   │            │
│        │                  │ Y.Doc    │  server-to-  │ Y.Doc    │            │
│        │                  │ :3913    │    server    │ :3913    │            │
│        │                  └────┬─────┘              └────┬─────┘            │
│        │                       │                         │                  │
│        │                       └──────────┬──────────────┘                  │
│        │                                  │                                 │
│        │                           ┌──────▼──────┐                          │
│        └──────────────────────────►│ Cloud Y.Doc │◄─────────────────────────│
│                                    │   :3913     │                          │
│                                    └─────────────┘                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

| Location        | Y.Doc count | Notes                          |
| --------------- | ----------- | ------------------------------ |
| Phone browser   | 1           | Client only (no local server)  |
| Laptop browser  | 1           | Connects to localhost          |
| Desktop browser | 1           | Connects to localhost          |
| Laptop server   | 1           | Sync node                      |
| Desktop server  | 1           | Sync node                      |
| Cloud server    | 1           | Sync node (optional)           |

### Provider strategy per device

| Device              | Acts as         | Connects to                                  |
| ------------------- | --------------- | -------------------------------------------- |
| Phone browser       | Client only     | desktop, laptop, cloud (no local server)     |
| Laptop browser      | Client          | localhost                                    |
| Desktop browser     | Client          | localhost                                    |
| Laptop server       | Server + client | desktop, cloud                               |
| Desktop server      | Server + client | laptop, cloud                                |
| Cloud server        | Server only     | (none; accepts connections, never initiates) |

The browser on a device with a local server connects only to localhost. The local server then handles cross-device sync over the LAN/Tailnet to other servers, and out to the cloud.

## The two public primitives

Apps reach the wire through one of two primitives. Both are sync clients; the difference is whether the document also participates in cross-peer collaboration (presence + RPC).

### `openCollaboration`

For the workspace document: tables, KV, replica, action registry, peers.

```ts
import {
    defineActions,
    defineMutation,
    openCollaboration,
    syncRoomUrl,
} from '@epicenter/workspace';

const collaboration = openCollaboration(ydoc, {
    url: syncRoomUrl('https://api.example.com', ydoc.guid),
    waitFor: idb.whenLoaded,
    openWebSocket: auth.openWebSocket,
    replica: { id: 'macbook', platform: 'tauri' },
    actions: defineActions({ tabs_close: defineMutation({ ... }) }),
});

// Local invocation: direct function call against the registry.
await collaboration.actions.tabs_close({ tabIds: [1, 2] });

// Remote invocation: find by stable replica id, dispatch by snake_case key.
const phone = collaboration.peers.find('phone');
await phone?.invoke('tabs_close', { tabIds: [1, 2] });
```

### `attachYjsSync`

For content documents nested inside a workspace (rich-text bodies, attachments, anything that syncs independently). No replica, no actions, no peers; just bytes over the wire.

```ts
import { attachYjsSync, syncRoomUrl } from '@epicenter/workspace';

const sync = attachYjsSync(bodyDoc, {
    url: syncRoomUrl('https://api.example.com', bodyDoc.guid),
    waitFor: bodyIdb.whenLoaded,
    openWebSocket: auth.openWebSocket,
});

await sync.whenConnected;
```

The status surface (`status`, `whenConnected`, `whenDisposed`, `onStatusChange`, `reconnect`) mirrors the sync portion of `openCollaboration`, so app code that gates UI on `whenConnected` works the same for either primitive.

## What `openCollaboration` does at construction

```
openCollaboration(ydoc, { url, identity, actions, ... })
        │
        ├─ build awareness  ─────────────────────┐
        │  attachAwareness(awareness, {          │
        │    schema: { identity, actionKeys },  │
        │    initial: { identity, actionKeys }  │
        │  })                                    │
        │                                        │
        ├─ start sync supervisor ────────────────┤
        │  createSyncSupervisor(ydoc, {          │
        │    awareness,                          │
        │    onRpcRequest:     dispatch action   │
        │    onRuntimeRequest: dispatch verb     │
        │  })                                    │
        │                                        │
        └─ build peers surface ──────────────────┘
           createPeersSurface(awareness, identity.id, {
             sendRequest:        ACTION dispatch
             sendRuntimeRequest: RUNTIME dispatch
           })
```

The returned `Collaboration<TActions>` exposes:

| Field             | What it is                                                          |
| ----------------- | ------------------------------------------------------------------- |
| `identity`        | Stable peer identity, echoed back from config                       |
| `actions`         | Live local action registry; call directly                           |
| `peers`           | Remote surface (`list`, `find`, `observe`)                          |
| `status`          | Current `SyncStatus` (`offline`/`connecting`/`connected`/`failed`)  |
| `whenConnected`   | Resolves on first successful handshake; rejects on permanent fail   |
| `whenDisposed`    | Resolves once the supervisor exits and the WebSocket closes         |
| `onStatusChange`  | Subscribe; returns unsubscribe                                      |
| `reconnect`       | Manually wake the supervisor (resets backoff)                       |
| `[Symbol.dispose]`| Sugar for `ydoc.destroy()`; cascades through every attachment       |

### `actionKeys` is alphabetically sorted, computed once

Every peer publishes its full set of action keys in the awareness state, sorted alphabetically. Because two peers running the same code produce byte-identical arrays, awareness updates do not ping-pong on irrelevant ordering differences.

`actionKeys` enables capability-based picks without an extra roundtrip:

```ts
const recorder = collaboration.peers.list().find((p) =>
    p.actionKeys.includes('whispering_start_recording'),
);
await recorder?.invoke('whispering_start_recording', { deviceId });
```

## The wire: three planes on one WebSocket

```
WebSocket (one socket per (Y.Doc, sync node) pair)
│
├─ MESSAGE_TYPE.SYNC          Yjs CRDT replication (STEP1/STEP2/UPDATE)
├─ MESSAGE_TYPE.AWARENESS     Presence frames
└─ MESSAGE_TYPE.RPC           Two sub-types share an envelope:
                              │
                              ├─ RPC_TYPE.ACTION_REQUEST   peer.invoke
                              ├─ RPC_TYPE.RUNTIME_REQUEST  peer.describe
                              └─ RPC_TYPE.RESPONSE         shared reply
```

### Sync plane (Yjs CRDT)

Standard Yjs sync protocol: STEP1 (state vector), STEP2 (missing updates), UPDATE (incremental changes). The supervisor encodes/decodes via `@epicenter/sync`'s `handleSyncPayload`.

### Awareness plane

Each peer publishes:

```ts
{
    identity: { id, name, platform },
    actionKeys: ['tabs_close', 'tabs_list', 'whispering_start_recording', ...],
}
```

`actionKeys` is the alphabetically sorted snake_case key listing computed at workspace startup; full schemas (input shapes, descriptions) are not in awareness. Apps that need them call `peer.describe()` on demand.

Custom awareness fields (cursors, typing indicators) are not added through `openCollaboration`; if you want them on the same socket, attach a separate `Awareness` instance and reuse the supervisor pattern. The standard fields above are owned by `openCollaboration` and reserved.

### RPC plane: two sub-types

Two distinct request kinds keep app behavior and collaboration runtime behavior on separate planes:

```ts
export const RPC_TYPE = {
    ACTION_REQUEST: 0,   // app action invocation by snake_case key ('tabs_close', ...)
    RESPONSE:       1,   // shared envelope for both request kinds
    RUNTIME_REQUEST: 2,  // closed-set runtime verb ('describe-actions')
} as const;
```

| Sub-type        | Authored by | Carries     | Surface                       |
| --------------- | ----------- | ----------- | ----------------------------- |
| ACTION_REQUEST  | App         | snake_case key    | `peer.invoke(path, input)`    |
| RUNTIME_REQUEST | Framework   | runtime verb| `peer.describe()` and friends |
| RESPONSE        | (envelope)  | result      | shared by both                |

The runtime verb set is closed:

```ts
export type RuntimeVerb = 'describe-actions';
```

Adding a new verb is a single union edit + a single switch branch in `openCollaboration`. The closed set is intentional: the framework decides what runtime introspection is universally available; the app decides everything else.

### Why two RPC sub-types

Apps own the action namespace fully. Earlier designs reserved `system.*` for runtime introspection (`system.describe`), which crowded the namespace and forced a string convention to keep them apart. Splitting at the wire kind makes the separation structural:

- App actions can use any name (including `system.foo`); they ride ACTION_REQUEST.
- Runtime verbs can never be shadowed; they ride RUNTIME_REQUEST and have a closed type.

The RESPONSE envelope is shared so the request-id table on the client side stays one map.

## The peers surface

```ts
collaboration.peers
    .list()                        // Peer[], clientID-ascending, never self
    .find<TMap>(replicaId)         // Peer<TMap> | undefined
    .observe(callback)             // unsubscribe = peers.observe(cb)
```

Each `Peer<TMap>` carries:

```ts
type Peer<TMap = unknown> = {
    readonly clientID: number;       // session-local; do not persist
    readonly subject: Subject;       // auth-derived user id from the server
    readonly replica: Replica;       // install-stable peer descriptor
    readonly actionKeys: readonly string[];
    invoke<TPath>(path, input, options?): Promise<Result<...>>;
    describe(options?): Promise<Result<ActionManifest, ...>>;
};
```

### Self filtering, in two layers

`peers.list()` and `peers.find()` filter self twice:

1. By transport `clientID`: drops the entry under `awareness.clientID`.
2. By `replica.id`: drops any entry whose published replica matches `collaboration.replica.id` (catches stale-self after reconnect under a new clientID).

Self is never reachable through the peers surface; local actions are reached via `collaboration.actions.*`. A wire-layer fallback in `openCollaboration` returns `SelfInvocationError` if a stale clientId reference ever reaches the supervisor.

### `waitForPeer` helper

```ts
const phone = await waitForPeer(collaboration.peers, 'phone', {
    timeoutMs: 5000,
});
if (!phone) return notFoundUi();
await phone.invoke('tabs_close', { tabIds: [1] });
```

Resolves with the `Peer` on first sighting, or `undefined` on timeout. `timeoutMs <= 0` is a synchronous one-shot lookup wrapped in a promise.

### Capability-based picks

`peers.list()` plus `actionKeys` covers fan-out without any extra surface:

```ts
const recorders = collaboration.peers
    .list()
    .filter((p) => p.actionKeys.includes('whispering_start_recording'));
```

No dedicated `peers.hosts(path)` helper exists; standard array methods are sufficient.

## Error variants

```ts
type RemoteCallError = RpcError | SelfInvocationError | PeerLeftError;
```

| Variant                       | Source                          | When                                    |
| ----------------------------- | ------------------------------- | --------------------------------------- |
| `RpcError.ActionNotFound`     | `@epicenter/sync`               | Bad action key on the remote           |
| `RpcError.Timeout`            | `@epicenter/sync`               | No response within the timeout         |
| `RpcError.PeerOffline`        | `@epicenter/sync`               | Server says the target is not connected |
| `RpcError.ActionFailed`       | `@epicenter/sync`               | Remote handler threw or returned Err    |
| `RpcError.Disconnected`       | `@epicenter/sync`               | Local socket closed mid-call           |
| `SelfInvocationError.SelfInvocation` | `@epicenter/workspace/document/peer` | Stale self-clientId reached the wire |
| `PeerLeftError.PeerLeft`      | `@epicenter/workspace/document/peer` | Peer disappeared from awareness mid-call |

Callers exhaustively switch on `error.name`; each variant carries the fields needed to render a useful message.

## Supervisor lifecycle

The internal `createSyncSupervisor` runs one loop that owns the WebSocket. Three timers participate:

| Timer                 | Default | Job                                             |
| --------------------- | ------- | ----------------------------------------------- |
| `CONNECT_TIMEOUT_MS`  | 15 s    | Abort a stuck-in-CONNECTING socket              |
| `PING_INTERVAL_MS`    | 60 s    | Keep the socket alive with a `'ping'` message   |
| `LIVENESS_TIMEOUT_MS` | 90 s    | Close the socket if no traffic for ≥ this long  |

### Connect, reconnect, backoff

```
                    ┌─────────────┐
                    │   offline   │ ◄── ydoc.destroy()
                    └──────┬──────┘
                           │ supervisor starts
                           ▼
                    ┌─────────────┐
       reconnect()  │ connecting  │
       wakes loop ─►│ retries=N   │ ──► attemptConnection(signal)
                    └──────┬──────┘
                           │ success
                           ▼
                    ┌─────────────┐
                    │  connected  │ ──► whenConnected.resolve()
                    └──────┬──────┘
                           │ ws.onclose
                           ▼
                       backoff sleep (jitter, capped at 30s)
                           │
                           └─► retry
```

Backoff: `min(BASE_DELAY_MS * 2 ** retries, MAX_DELAY_MS)` * `(0.5 + Math.random() * 0.5)`. Window `online`, `offline`, and `visibilitychange` events wake the backoff or close the socket as appropriate.

### Permanent failure

Server-side rejection of auth uses the WebSocket close code `4401` with a JSON body `{ "code": "<reason>" }`. Documented reasons today: `'invalid_token'`, `'token_expired'`, `'deauthorized'`, `'unknown'`. On 4401:

- Status transitions to `{ phase: 'failed', reason: { type: 'auth', code } }`
- `whenConnected` rejects with `SyncFailedError.AuthRejected({ code })`
- Loop parks; only a manual `reconnect()` reopens

### Cancellation hierarchy

```
masterController          aborts on ydoc.destroy(); kills everything
   ▼
cycleController           aborts on reconnect();
                          kills the current iteration only
```

`cycleController` is replaced (not just re-aborted) by `reconnect()` so the new cycle has a fresh signal unrelated to the old. The supervisor reads `cycleController.signal` fresh at the top of each iteration; aborting the old wakes a parked supervisor and the next iteration picks up the replacement.

### Pending-RPC table

Outbound RPC requests live in `pendingRequests: Map<requestId, { action, resolve, timer }>`. Cleared on every `ws.onclose`: a fresh server-side context will never resolve the prior connection's IDs, so callers receive `RpcError.Disconnected` immediately rather than waiting out the timeout.

## A full call: `peer.describe('macbook-pro')`

End-to-end. A fuji-running script asks `macbook-pro` (a tab-manager peer) for its action manifest.

```
┌─────────────────────┐                          ┌─────────────────────┐
│  Fuji process       │                          │  macbook-pro        │
│  collaboration.*    │                          │  (tab-manager)      │
└──────────┬──────────┘                          └─────────┬───────────┘
           │                                               │
           │ 1. peer = collaboration.peers.find('macbook-pro')
           │    (reads Awareness, filters self,           │
           │     returns Peer { clientID: 42 })           │
           │                                               │
           │ 2. peer.describe()                           │
           │    → dispatch via sendRuntimeRequest         │
           │      (verb = 'describe-actions')             │
           │                                               │
           │ 3. supervisor.sendRuntimeRequest(            │
           │      target=42, 'describe-actions', opts)    │
           │                                               │
           │ ── encodeRpcRuntimeRequest ────────────►     │
           │    [varuint MESSAGE_TYPE.RPC]                │
           │    [varuint RPC_TYPE.RUNTIME_REQUEST]        │
           │    [varuint requestId]                       │
           │    [varuint targetClientId=42]               │
           │    [varuint requesterClientId]               │
           │    [varString verb='describe-actions']       │
           │                                               │
           │    [pending-request timer running, 5s]       │
           │                                               │ 4. ws.onmessage
           │                                               │    decodeRpcPayload
           │                                               │    → { type: 'runtime-request', verb }
           │                                               │
           │                                               │ 5. supervisor calls
           │                                               │    onRuntimeRequest(rpc)
           │                                               │
           │                                               │ 6. switch(rpc.verb) {
           │                                               │      case 'describe-actions':
           │                                               │        return Ok(Object.fromEntries(
           │                                               │          Object.entries(userActions).map(
           │                                               │            ([key, action]) => [key, toActionMeta(action)]
           │                                               │          )
           │                                               │        ))
           │                                               │    }
           │                                               │
           │ ◄── encodeRpcResponse ───────────────────    │
           │     [varuint RPC_TYPE.RESPONSE]              │
           │     [varuint requestId]                      │
           │     [varuint requesterClientId]              │
           │     [JSON Result envelope]                   │
           │                                               │
           │ 7. ws.onmessage matches requestId in         │
           │    pendingRequests, clears the timer,        │
           │    resolves with the manifest                │
           │                                               │
           │ 8. peer.describe() resolves                  │
           │    → Result<ActionManifest, RemoteCallError> │
           │                                               │
```

`peer.invoke(path, input)` follows the same shape, but rides ACTION_REQUEST and `onRpcRequest` resolves the path against `collaboration.actions`.

### Peer-removed race semantics

`peer.invoke` and `peer.describe` race the dispatch against a peer-removed signal. The dispatch helper subscribes to `awareness.on('change', ...)` for the lifetime of the call; if the target's clientID disappears from awareness before the response arrives, the in-flight Promise resolves with `PeerLeftError.PeerLeft({ peerId, action })` instead of waiting out the RPC timeout.

```
peer.invoke('tabs_close', { tabIds: [1] })
  │
  ├─ subscribe: awareness.on('change', onChange)
  ├─ check:    peer still in readPeers()? If no → PeerLeft (synchronous)
  ├─ fire:     supervisor.sendRpcRequest(...)
  │
  ├─ if RPC resolves first:        → return its Result
  ├─ if peer leaves awareness first → return PeerLeft
  └─ either way:                    awareness.off('change', onChange)
```

## Construction → first connect, in time

```
t=0           openCollaboration(ydoc, { url, identity, actions, ... })
              ├─ Object.freeze(actionKeys.sort())     // computed once
              ├─ new Awareness(ydoc)
              ├─ attachAwareness(awareness, { schema, initial })
              │   └─ awareness.setLocalState({ identity, actionKeys })
              │
              ├─ createSyncSupervisor(ydoc, {
              │     awareness, onRpcRequest, onRuntimeRequest, ...
              │   })
              │   └─ ydoc.on('updateV2', handleDocUpdate)
              │   └─ awareness.on('update', handleAwarenessUpdate)
              │   └─ ydoc.once('destroy', dispose-cascade)
              │   └─ supervisor loop starts
              │
              └─ createPeersSurface(awareness, identity.id, hooks)

t=0.x         Returns Collaboration<TActions>. Synchronous so far.

t=1ms         Supervisor: await waitFor (e.g. idb.whenLoaded).

t=Nms         waitFor resolves. Supervisor enters connecting loop.

t=N+ε         attemptConnection(signal):
                openWebSocket(url, [MAIN_SUBPROTOCOL])
                ws.onopen → encodeSyncStep1, sendLocalAwarenessState
                ws.onmessage SYNC STEP2/UPDATE → handshakeComplete
                setStatus({ phase: 'connected' })
                connected.resolve()

t=N+δ         whenConnected resolves. Apps can call collaboration.peers.list().
```

## Mental model in one paragraph

`openCollaboration(ydoc, config)` is the wire and the supervisor for a participating workspace. It builds an `Awareness` for presence (`identity` + `actionKeys`), starts the supervisor loop that owns the WebSocket and runs the Yjs sync protocol, and exposes a `peers` surface backed by two wire kinds: `peer.invoke` rides ACTION_REQUEST (app actions by snake_case key), `peer.describe` rides RUNTIME_REQUEST (closed-set framework verbs). Self is filtered at two layers and reachable only as `collaboration.actions.*` (the live local registry, called directly). Errors are typed: `RpcError | SelfInvocationError | PeerLeftError` as `RemoteCallError`. Lifecycle is supervisor-driven (exponential backoff with jitter, 60 s pings, 90 s liveness, permanent-park on close code 4401), and `whenDisposed` resolves once the cascade from `ydoc.destroy()` finishes. Content documents that need bytes-only sync use `attachYjsSync(ydoc, config)`: same supervisor lifecycle, no presence, no RPC.
