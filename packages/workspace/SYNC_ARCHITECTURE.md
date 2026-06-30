# Multi-Node Sync Architecture

Epicenter replicates a `Y.Doc` across many nodes over a WebSocket relay. Yjs's CRDT semantics keep every replica eventually consistent regardless of message order or how many nodes are connected. The relay is a dumb pipe: it moves bytes, never executes business logic.

This document describes the runtime: the one public primitive (`openCollaboration`), the handle it returns, and how the wire is organized.

## One primitive: `openCollaboration`

Every document that participates in sync, the workspace doc and every nested content doc, goes through `openCollaboration`. There is no second primitive. The workspace doc passes a real action registry; content docs pass `actions: {}`.

```ts
import {
    defineActions,
    defineMutation,
    openCollaboration,
    roomWsUrl,
} from '@epicenter/workspace';

const collaboration = openCollaboration(ydoc, {
    url: roomWsUrl({ baseURL, ownerId, guid: ydoc.guid, nodeId }),
    waitFor: idb.whenLoaded,
    openWebSocket: auth.openWebSocket,
    onReconnectSignal: auth.onStateChange,
    actions: defineActions({
        tabs_close: defineMutation({ /* ... */ }),
    }),
});

// Local invocation: direct function call against the registry.
await collaboration.actions.tabs_close({ tabIds: [1, 2] });

// Online peers (relay-owned presence), each carrying its published action
// manifest and the relay-floor MCP routes it exposes.
const phone = collaboration.peers
    .list()
    .find((peer) => peer.nodeId === 'phone');
```

Cross-device tool calls do not ride this handle. A device exposes a named MCP route over the relay-channel floor, and a signed-in client reaches it over the same socket; see [the relay-channel plane](#relay-channel-plane-text-blind) below and ADR-0073.

Content docs (rich-text bodies, attachments, anything nested that syncs independently) use the same call with `actions: {}`: the published manifest is empty, while sync and presence are unchanged.

## The `Collaboration` handle

`openCollaboration` returns synchronously:

| Field             | What it is                                                         |
| ----------------- | ------------------------------------------------------------------ |
| `actions`         | Live local action registry; call directly                          |
| `status`          | Current `SyncStatus` (`offline`/`connecting`/`connected`/`failed`) |
| `whenConnected`   | Resolves on first successful handshake; rejects on permanent fail  |
| `whenDisposed`    | Resolves once the supervisor exits and the socket closes           |
| `onStatusChange`  | Subscribe to status changes; returns unsubscribe                   |
| `reconnect`       | Manually wake the supervisor (resets backoff)                      |
| `peers`         | `list()` / `subscribe()` over the server-owned presence channel    |
| `textPort`        | Raw text-frame port; the relay-channel floor builds blind MCP channels on top |
| `[Symbol.dispose]`| Sugar for `ydoc.destroy()`; cascades through every attachment      |

`peers.list()` returns `Peer[]`, where each peer carries `{ nodeId, connectedAt, actions, agentId?, exposedRoutes? }`. `actions` is the peer's published `ActionManifest` (the metadata-only projection of its `ActionRegistry`), suitable for rendering UI affordances, validating input against schemas, or feeding an AI tool layer. `exposedRoutes` lists the relay-floor MCP route names that peer serves with `relay: 'exposed'` (a daemon's opted-in gateway routes, for example `['books']`); a signed-in client reads it to discover which devices to auto-mount as cross-device tool catalogs.

## The wire: one socket, three channels

`openCollaboration` opens exactly one authenticated WebSocket per `(Y.Doc, relay)` pair. Three channels share that socket:

```
binary frames   ->  Yjs CRDT sync (STEP1 / STEP2 / UPDATE)
text frames     ->  presence (the server-owned peer list)
text frames     ->  relay-channel (blind MCP byte pipe)
```

Channels are independent: a malformed relay-channel frame does not tear down sync. The server NEVER inspects the contents of a Yjs binary frame or a relay-channel byte chunk; it only routes and persists.

### Sync plane (binary)

Standard Yjs sync: STEP1 (state vector), STEP2 (missing updates), UPDATE (incremental changes). The supervisor encodes and decodes through `@epicenter/sync`'s `handleSyncPayload`. The first STEP2 or UPDATE after connect completes the handshake and flips status to `connected`.

The server merges every update it sees (Yjs is multi-writer; admission control is not the server's job here) and fans out to peers excluding origin. The update log persists to per-room storage and is opportunistically compacted when the room empties.

### Presence plane (server-owned)

The relay tracks live WebSocket connections in a `connections` Map. That map is the source of truth for "who is here." On every membership or manifest change it broadcasts one server-to-client text frame carrying the whole list:

```ts
type PresenceFrame = {
    type: 'presence';
    peers: Peer[];
};

type Peer = {
    nodeId: string;
    connectedAt: number;
    actions: ActionManifest;   // Record<string, ActionMeta>
    agentId?: string;          // set only by a resident agent mount (ADR-0025)
    exposedRoutes?: string[];  // relay-floor MCP route names served with `relay: 'exposed'`
};
```

- The frame is sent to a freshly-upgraded socket, and rebroadcast to every other socket whenever a peer joins, leaves, or republishes its manifest.
- `peers` is computed per recipient with the receiver's own install excluded, so the client stores it verbatim.
- Multi-tab same-install collapses to one row (newest-wins by `connectedAt`); a graceful tab handoff produces no wire-visible transition (300 ms debounce).
- A close code of `4401` (permanent auth failure) bypasses the debounce: the dropped peer disappears from everyone else's list immediately.

There is no delta protocol. The relay owns the whole truth and ships the whole truth on every change; the client never reassembles `added` / `removed` events.

Nodes publish their own manifest with one client-to-server frame on every (re)connect:

```ts
type PresencePublishFrame = {
    type: 'presence_publish';
    actions: ActionManifest;
};
```

The relay stores the manifest against the sending socket's connection attachment (so it survives Cloudflare hibernation via `serializeAttachment`) and rebroadcasts presence so peers see the update.

`openCollaboration` builds its own manifest from the action registry via `toActionMeta` at construction and publishes it on every successful connect.

#### Why server-owned, not awareness

Presence used to ride y-protocols Awareness. Awareness is built for ephemeral peer-to-peer state with concurrent per-peer writers (cursors, selections, typing indicators), not for a server-authoritative fact the relay already holds in its `connections` Map. Moving presence onto a plain server-pushed channel deleted the awareness round-trip, the Durable Object hibernation restore loop, and the clock-fabrication seed.

Cursor and selection sync, when they arrive, bring Awareness back, used for what it is designed for and kept separate from this presence channel.

### Relay-channel plane (text, blind)

A cross-device tool call rides text frames on the same socket as presence and sync, but the relay never understands them: the relay-channel layer multiplexes named request/response channels, and the relay forwards each channel's bytes BLIND. This is the relay floor (ADR-0073): one per-user authenticated socket that routes typed channels to a person's own devices, with sync as the first channel and cross-device tool calls as another.

The wire is a four-frame, reset-only channel protocol. `id` is the caller-minted channel correlation id, echoed unchanged:

```ts
caller -> relay -> target:  { type: 'channel_open',   id, target, route }
target -> relay -> caller:  { type: 'channel_accept', id }
either <-> relay <-> other: { type: 'channel_data',   id, bytes }  // opaque base64 chunk
either <-> relay <-> other: { type: 'channel_reset',  id, code }   // terminal, both directions
```

End to end:

```
caller                      relay                         target device
──────                      ─────                         ─────────────
channel_open ─────────────▶ validate `target` is a live
{ id, target, route }       same-owner device, stamp the
                            authenticated source
                            { kind: 'user', userId }
                            │
                            ├─ no live socket ─▶ channel_reset { offline }
                            │
                            └─ channel_open ────────────▶ acceptor admits only if
                                                          source.userId is its own
                                                          owner AND `route` is
                                                          relay: 'exposed'
                            ◀── channel_accept ───────────┘
   channel_data  ◀────────  forward bytes verbatim  ──────────▶  channel_data
   (MCP request / response; the relay decodes neither direction)
```

The bytes inside `channel_data` are an MCP session today (an HTTP one later); the relay base64-forwards them and parses nothing. Authorization is two server-side checks with no device-key ledger: the relay stamps the caller's authenticated `source` (overwriting any caller-supplied value), and the device acceptor admits the channel only when `source.userId` matches its own owner and the named route was opted in with `--relay-expose` (default refused, ADR-0078). A `channel_reset` is the terminal frame in both directions: `closed` is a clean end, while `offline`, `refused`, `cancelled`, `too_large`, and `protocol_error` are the failure codes.

There is no in-room request/response RPC on this socket. Cross-device capability is exclusively the relay floor's explicitly-exposed MCP routes: a daemon advertises its `relay: 'exposed'` route names in account-room presence via `exposedRoutes`, and a signed-in client auto-mounts every advertised `(device, route)` of its own fleet as an MCP tool catalog over this channel transport.

## URLs and routing

A cloud document is owned by the authenticated `OwnerId` and addressed by its own `ydoc.guid`. The client builds the URL from `(baseURL, ownerId, guid, nodeId)`:

```ts
roomWsUrl({
    baseURL: 'https://api.epicenter.so',
    ownerId,
    guid: ydoc.guid,
    nodeId,
});
// -> wss://api.epicenter.so/api/owners/<ownerId>/rooms/<guid>?nodeId=<id>
```

In personal mode `ownerId` equals the signed-in user's id; in shared mode it is
the literal `'shared'`. The URL shape is uniform across both modes. The relay
takes the user from the auth token, resolves the expected owner partition for
the deployment, verifies the URL `:ownerId` matches that partition, and builds
the internal Durable Object name `owners/${ownerId}/rooms/${room}`. Personal
deployments resolve one partition per user. Shared-wiki deployments resolve one
shared partition for admitted users.

This is the consumer Google Docs model and the first of three account layers, introduced over time:

- **Layer 1 (this)**: personal content. `owners/${ownerId}` owns the doc, where `ownerId === userId`.
- **Layer 1.5 (future)**: sharing. A per-document ACL grants other users access; the owner's DO name does not change.
- **Layer 2 (future)**: shared-drive content. A shared-wiki deployment uses `ownerId === 'shared'` so content survives a departing user.
- **Layer 3 (future)**: tenancy and billing. An organization groups user accounts for one invoice and admin policy; it never owns a document.

`nodeId` is appended as a query parameter (`?nodeId=`) on every connect, including reconnects. It is a routing label stamped on the socket at upgrade, not an auth principal: the relay authorizes the room from the token, and within that room `nodeId` only decides which socket the relay routes a frame to (a presence push, or a relay-channel byte chunk).

`/owners/:ownerId/rooms/:room` is the single cloud sync route shape (personal: `:ownerId` is the user id; shared: `:ownerId === 'shared'`). Browser apps and the workspace daemon both build their URL with `roomWsUrl`.

## Supervisor lifecycle

`openCollaboration` wraps an internal `createSyncSupervisor` that owns the WebSocket. Three timers participate:

| Timer                 | Default | Job                                                         |
| --------------------- | ------- | ----------------------------------------------------------- |
| `CONNECT_TIMEOUT_MS`  | 15 s    | Abort a socket stuck in CONNECTING                          |
| `PING_INTERVAL_MS`    | 60 s    | Send a `'ping'` text frame to keep the socket alive         |
| `LIVENESS_TIMEOUT_MS` | 90 s    | Close the socket if no traffic arrives for this long (checked every 10 s) |

### Connect, reconnect, backoff

```
   ┌─────────────┐
   │   offline   │ ◄── ydoc.destroy()
   └──────┬──────┘
          │ waitFor resolves
          ▼
   ┌─────────────┐
   │ connecting  │ ──► attemptConnection(signal)
   │ retries=N   │ ◄── reconnect() wakes the loop
   └──────┬──────┘
          │ STEP2/UPDATE handshake
          ▼
   ┌─────────────┐
   │  connected  │ ──► whenConnected.resolve()
   │             │ ──► presence_publish sent
   └──────┬──────┘
          │ ws.onclose
          ▼
   backoff sleep (jittered, capped at 30 s)
          │
          └─► retry
```

Backoff is `min(BASE_DELAY_MS * 2 ** retries, MAX_DELAY_MS)` scaled by `0.5 + Math.random() * 0.5`. Window `online`, `offline`, and `visibilitychange` events wake the backoff or close the socket as appropriate.

### Permanent failure

A server-side auth rejection closes the WebSocket with code `4401` and a JSON reason `{ "code": "<reason>" }`. Codes seen today: `invalid_token`, `token_expired`, `deauthorized`, `unknown`. On 4401:

- Status becomes `{ phase: 'failed', reason: { type: 'auth', code } }`.
- `whenConnected` rejects with `SyncFailedError.AuthRejected({ code })`.
- The supervisor parks; only `reconnect()` reopens it. Apps wire `reconnect()` to `auth.onStateChange` so a sign-in retries automatically.

### Cancellation hierarchy

```
masterController   aborts on ydoc.destroy(); kills everything
   ▼
cycleController    aborts on reconnect(); kills the current iteration only
```

`reconnect()` replaces `cycleController` (rather than just re-aborting it) so the next cycle gets a fresh signal unrelated to the old one. The supervisor reads `cycleController.signal` fresh at the top of each iteration; aborting the old one wakes a parked supervisor and the next iteration picks up the replacement.

## Mental model in one paragraph

`openCollaboration(ydoc, config)` is the one collaboration primitive: it opens a single WebSocket to the relay, runs the Yjs binary sync protocol, publishes its own action manifest at connect via `presence_publish`, mirrors the relay's server-owned presence channel into `peers` (including each peer's manifest and exposed route names), and exposes a raw `textPort` that the relay-channel floor rides for blind cross-device MCP. The relay is a dumb pipe: it merges Yjs updates (eventually consistent CRDT semantics, no admission control), tracks the live connections Map (source of truth for who is here), and forwards relay-channel byte frames without parsing them. Presence is the relay's `connections` Map, not Yjs Awareness. Cross-device tool calls ride the relay-channel floor as MCP (ADR-0073), not an in-room RPC. Content docs use the same primitive with `actions: {}`.
