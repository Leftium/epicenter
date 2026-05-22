# Multi-Device Sync Architecture

Epicenter replicates a `Y.Doc` across many devices over a WebSocket relay. Yjs's CRDT semantics keep every replica eventually consistent regardless of message order or how many devices are connected.

This document describes the runtime: the one public primitive (`openCollaboration`), the handle it returns, and how the wire is organized.

## One primitive: `openCollaboration`

Every document that participates in sync, the workspace doc and every nested content doc, goes through `openCollaboration`. There is no second primitive. The workspace doc passes a real action registry; content docs pass `actions: {}`.

```ts
import {
    defaultWorkspaceAppDocWsUrl,
    defineActions,
    defineMutation,
    openCollaboration,
} from '@epicenter/workspace';

const collaboration = openCollaboration(ydoc, {
    url: defaultWorkspaceAppDocWsUrl('https://api.epicenter.so', {
        appId: 'tab-manager',
        docId: 'root',
    }),
    waitFor: idb.whenLoaded,
    openWebSocket: auth.openWebSocket,
    installationId: 'macbook',
    actions: defineActions({ tabs_close: defineMutation({ /* ... */ }) }),
});

// Local invocation: direct function call against the registry.
await collaboration.actions.tabs_close({ tabIds: [1, 2] });

// Remote invocation: pick an online install, dispatch to it over HTTP.
const phone = collaboration.devices
    .list()
    .find((device) => device.installationId === 'phone');
if (phone) {
    const { data, error } = await collaboration.dispatch({
        to: phone.installationId,
        action: 'tabs_close',
        input: { tabIds: [1, 2] },
        signal: AbortSignal.timeout(5_000),
    });
}
```

Content docs (rich-text bodies, attachments, anything nested that syncs independently) use the same call with `actions: {}`. Inbound dispatch frames reply `ActionNotFound`; sync and presence are unchanged.

## The `Collaboration` handle

`openCollaboration` returns synchronously:

| Field             | What it is                                                         |
| ----------------- | ------------------------------------------------------------------ |
| `installationId`  | Install-stable routing label, echoed from config                  |
| `actions`         | Live local action registry; call directly                         |
| `status`          | Current `SyncStatus` (`offline`/`connecting`/`connected`/`failed`) |
| `whenConnected`   | Resolves on first successful handshake; rejects on permanent fail  |
| `whenDisposed`    | Resolves once the supervisor exits and the socket closes           |
| `onStatusChange`  | Subscribe to status changes; returns unsubscribe                   |
| `reconnect`       | Manually wake the supervisor (resets backoff)                      |
| `devices`         | `list()` / `subscribe()` over the server-owned presence channel    |
| `presence`        | `{ hasSnapshot }`: has the relay's first snapshot landed yet       |
| `dispatch`        | Fire a cross-device call over HTTP                                 |
| `[Symbol.dispose]`| Sugar for `ydoc.destroy()`; cascades through every attachment      |

There is no `peers` surface, no `identity`, no `actionKeys`. Presence is server-owned and surfaced as `devices`; cross-device calls are HTTP and surfaced as `dispatch`.

## The wire: one socket, two frame kinds, plus HTTP

`openCollaboration` opens exactly one WebSocket per `(Y.Doc, relay)` pair, and uses one HTTP endpoint alongside it.

```
WebSocket
│
├─ binary frames   Yjs CRDT sync (STEP1 / STEP2 / UPDATE)
│
└─ text frames     server -> client:  presence_snapshot
                                      presence_added
                                      presence_removed
                   server -> client:  dispatch_inbound
                   client -> server:  dispatch_response

HTTP
│
└─ POST .../dispatch   caller-side dispatch (fire and await)
```

Three concerns, three transports inside one connection:

- **Durable doc state** rides binary Yjs frames. Multi-writer, conflict-free.
- **Presence** rides text frames pushed by the relay. The relay owns it.
- **Dispatch** is a request/response over HTTP; the relay forwards `dispatch_inbound` / `dispatch_response` text frames in the middle.

None of the three touch the others. There is no awareness protocol, and no reserved Y.Doc array for presence or RPC.

### Sync plane (binary)

Standard Yjs sync: STEP1 (state vector), STEP2 (missing updates), UPDATE (incremental changes). The supervisor encodes and decodes through `@epicenter/sync`'s `handleSyncPayload`. The first STEP2 or UPDATE after connect completes the handshake and flips status to `connected`.

### Presence plane (server-owned)

The relay tracks live WebSocket connections in a `connections` Map. That map is the source of truth for "who is online." It publishes changes as three server-to-client text frames:

```ts
type PresenceSnapshotFrame = { type: 'presence_snapshot'; installs: string[] };
type PresenceAddedFrame    = { type: 'presence_added';    install: string };
type PresenceRemovedFrame  = { type: 'presence_removed';  install: string };
```

- `presence_snapshot` is sent to a freshly-upgraded socket. It lists every other connected install (the receiver is excluded) and replaces the client's local set.
- `presence_added` fires when the FIRST socket for an install connects. Multi-tab same-install does not re-emit it.
- `presence_removed` fires when the LAST socket for an install closes, after a short grace window that coalesces a graceful tab handoff into no wire-visible transition.

Clients never SEND presence frames. Connecting is the publish; the URL-stamped `installationId` is the address.

The client side is `createPresenceTracker`: it ingests frames into a `Set<string>`, dedupes multi-tab, excludes self, and notifies subscribers. `Collaboration.devices` reads straight from it:

```ts
collaboration.devices.list();        // LiveDevice[], self excluded, id-sorted
collaboration.devices.subscribe(fn); // fires on every snapshot/add/remove
```

`LiveDevice` is exactly `{ installationId: string }`. Display names, cursors, and capability lists are app concerns and live in app-owned tables, not on the presence wire.

`presence.hasSnapshot` is `false` between the WebSocket upgrade and the first `presence_snapshot`, then `true` for the session. The daemon's run-handler reads it to suppress a spurious `PeerNotFound` during that one-RTT window, when `devices.list()` would otherwise return `[]` for an install that is in fact online.

#### Why server-owned, not awareness

Presence used to ride y-protocols Awareness. Awareness is built for ephemeral peer-to-peer state with concurrent per-peer writers (cursors, selections, typing indicators), not for a server-authoritative fact the relay already holds in its `connections` Map. Moving presence onto a plain server-pushed channel deleted the awareness round-trip, the Durable Object hibernation restore loop, and the clock-fabrication seed. See `specs/20260521T121500-server-owned-presence.md` for the full argument.

Cursor and selection sync, when they arrive, bring Awareness back, used for what it is designed for and kept separate from this presence channel.

### Dispatch (HTTP)

A cross-device call is an HTTP `POST` to the relay's `/dispatch` endpoint, derived from the sync URL by `deriveDispatchUrl` (swap `ws`/`wss` to `http`/`https`, append `/dispatch`).

```ts
const { data, error } = await collaboration.dispatch({
    to: 'phone',                       // target installationId
    action: 'tabs_close',              // snake_case action key
    input: { tabIds: [1, 2] },         // omit for no-argument actions
    signal: AbortSignal.timeout(5_000),
});
```

End to end:

```
caller                      relay                        recipient
──────                      ─────                        ─────────
POST /dispatch ───────────▶  look up `to` in
{ from, to, action, input }  the connections Map
                             │
                             ├─ no live socket ─▶ 200 { error: RecipientOffline }
                             │
                             └─ push dispatch_inbound ──▶ runInboundDispatch:
                                  (text frame)              actions[action](input)
                                                            │
                             ◀── dispatch_response ─────────┘
                                  (text frame)
       200 { data } ◀──────  relay completes the held
       or { error }          HTTP request
```

The caller's `signal` (or the platform fetch timeout) is the only deadline; the relay holds the HTTP request open until the recipient responds or the caller aborts.

`dispatch` always resolves to `Result<unknown, DispatchError>`:

| Variant            | Produced by | When                                                       |
| ------------------ | ----------- | ---------------------------------------------------------- |
| `RecipientOffline` | relay       | No live socket for `to`, or its socket closed mid-handler  |
| `ActionNotFound`   | recipient   | Recipient has no handler for `action`                      |
| `ActionFailed`     | recipient   | Recipient handler threw or returned `Err`; `cause` is a string |
| `Cancelled`        | local       | Caller's `AbortSignal` aborted before the response arrived |
| `NetworkFailed`    | local       | The HTTP request failed before reaching the relay          |

`RecipientOffline`, `ActionNotFound`, and `ActionFailed` arrive inside the HTTP 200 body; `Cancelled` and `NetworkFailed` are produced locally.

For a type-narrowed success payload against a known target registry, lift through `typedDispatch`:

```ts
import { typedDispatch } from '@epicenter/workspace';
import type { TabManagerActions } from '@epicenter/tab-manager/actions';

const tabManager = typedDispatch<TabManagerActions>(collaboration.dispatch);
const { data } = await tabManager({
    to: phone.installationId,
    action: 'tabs_close',
    input: { tabIds: [1, 2] },
});
```

The runtime call is unchanged; `typedDispatch` only constrains the action key and the input/output types. The relay routes by `installationId` only; it does not prove the target install implements `TActions`.

The recipient side is `runInboundDispatch`: the supervisor routes inbound text frames to it, it looks up the action in the local registry, runs it, and emits the `dispatch_response`. A content doc with `actions: {}` always replies `ActionNotFound`.

## URLs and routing

The client never embeds a workspaceId. It builds the URL from `(apiUrl, appId, docId)`:

```ts
defaultWorkspaceAppDocWsUrl('https://api.epicenter.so', {
    appId: 'tab-manager',
    docId: 'root',
});
// -> wss://api.epicenter.so/me/apps/tab-manager/docs/root
```

The relay resolves which workspace to use from the auth token (the user's default workspace), runs a Workspace membership check, then builds the internal Durable Object name. If the user has no default workspace, the relay closes the socket with code 4401 and reason `{ code: 'no_default_workspace' }`, and the supervisor parks in `failed`.

`installationId` is appended as a query parameter (`?installationId=`) on every connect, including reconnects. It is a routing label stamped on the socket at upgrade, not an auth principal: the relay authorizes the room from the token, and within that room `installationId` only decides which socket dispatch is delivered to.

The workspace daemon and non-Cloud sample apps use the `/rooms/:room` route family via `roomWsUrl`, imported directly from `@epicenter/workspace`'s internal `transport` module rather than the package root, so app code cannot open a parallel sync surface that bypasses Workspace membership.

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
   └──────┬──────┘
          │ ws.onclose
          ▼
   backoff sleep (jittered, capped at 30 s)
          │
          └─► retry
```

Backoff is `min(BASE_DELAY_MS * 2 ** retries, MAX_DELAY_MS)` scaled by `0.5 + Math.random() * 0.5`. Window `online`, `offline`, and `visibilitychange` events wake the backoff or close the socket as appropriate.

### Permanent failure

A server-side auth rejection closes the WebSocket with code `4401` and a JSON reason `{ "code": "<reason>" }`. Codes seen today: `invalid_token`, `token_expired`, `deauthorized`, `no_default_workspace`, `unknown`. On 4401:

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

## Construction to first connect, in time

```
t=0      openCollaboration(ydoc, { url, installationId, actions, ... })
         ├─ validate action keys against ACTION_KEY_PATTERN
         ├─ createPresenceTracker(installationId)
         ├─ createSyncSupervisor(ydoc, { url, waitFor, openWebSocket, onTextFrame })
         │   ├─ ydoc.on('updateV2', handleDocUpdate)
         │   ├─ ydoc.once('destroy', dispose-cascade)
         │   └─ supervisor loop starts
         └─ returns Collaboration synchronously

t=1ms    supervisor: await waitFor (e.g. idb.whenLoaded)

t=Nms    waitFor resolves; supervisor enters the connecting loop

t=N+ε    attemptConnection(signal):
           openWebSocket(url + '?installationId=...', [MAIN_SUBPROTOCOL])
           ws.onopen   -> send encodeSyncStep1
           ws.onmessage SYNC STEP2/UPDATE -> handshake complete
                        -> status 'connected', whenConnected resolves
           ws.onmessage text presence_snapshot -> presence.hasSnapshot = true

t=N+δ    devices.list() reflects the relay's connections Map
```

## Mental model in one paragraph

`openCollaboration(ydoc, config)` is the one collaboration primitive: it opens a single WebSocket to the relay, runs the Yjs binary sync protocol, mirrors the relay's server-owned presence channel into `devices`, and runs inbound dispatch frames against the local `actions` registry. Cross-device calls go out through `dispatch(...)`, a plain HTTP POST the relay routes to the recipient's socket and answers with a typed `Result<unknown, DispatchError>`. Presence is the relay's `connections` Map, not Yjs Awareness; dispatch is HTTP, not a Y.Doc array. Lifecycle is supervisor-driven: exponential backoff with jitter, 60 s pings, 90 s liveness, permanent park on close code 4401, and `whenDisposed` resolves once the cascade from `ydoc.destroy()` finishes. Content docs use the same primitive with `actions: {}`.
