# Multi-Device Sync Architecture

Epicenter's sync system enables Y.Doc replication across multiple devices and servers using WebSocket. Every device with a filesystem can run an Elysia server as a **sync node**, and Yjs's multi-provider support allows connecting to multiple nodes simultaneously.

## Core Concepts

### Sync Nodes

A **sync node** is any device running an Elysia server with the sync plugin enabled. Sync nodes:

- Hold a Y.Doc instance in memory
- Accept WebSocket connections from browsers and other servers
- Broadcast updates to all connected clients
- Can connect to OTHER sync nodes as a client (server-to-server sync)

### Multi-Provider Architecture

Yjs supports **multiple providers simultaneously**. Each provider connects to a different sync node, and changes merge automatically via CRDTs:

```typescript
// A Y.Doc can connect to multiple servers at once
const doc = new Y.Doc();

// Provider 1: Local desktop server
new WebsocketProvider('ws://desktop.tailnet:3913/rooms/blog', 'blog', doc);

// Provider 2: Laptop server
new WebsocketProvider('ws://laptop.tailnet:3913/rooms/blog', 'blog', doc);

// Provider 3: Cloud server
new WebsocketProvider('wss://sync.myapp.com/rooms/blog', 'blog', doc);

// Changes sync through ALL connected providers
// Yjs deduplicates updates automatically
```

### Why This Works

- **CRDTs**: Yjs uses Conflict-free Replicated Data Types; updates merge regardless of order
- **Vector Clocks**: Each update has a unique ID; same update received twice is applied once
- **Eventual Consistency**: All Y.Docs converge to identical state, guaranteed

## Network Topology

### Example Setup (3 Devices + Cloud)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SYNC NODE NETWORK                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   PHONE                    LAPTOP                     DESKTOP               │
│   ┌──────────┐            ┌──────────┐              ┌──────────┐           │
│   │ Browser  │            │ Browser  │              │ Browser  │           │
│   │ Y.Doc    │            │ Y.Doc    │              │ Y.Doc    │           │
│   └────┬─────┘            └────┬─────┘              └────┬─────┘           │
│        │                       │                         │                  │
│   (no server)             ┌────▼─────┐              ┌────▼─────┐           │
│        │                  │ Elysia   │◄────────────►│ Elysia   │           │
│        │                  │ Y.Doc    │  server-to-  │ Y.Doc    │           │
│        │                  │ :3913    │    server    │ :3913    │           │
│        │                  └────┬─────┘              └────┬─────┘           │
│        │                       │                         │                  │
│        │                       └──────────┬──────────────┘                  │
│        │                                  │                                 │
│        │                           ┌──────▼──────┐                          │
│        └──────────────────────────►│ Cloud Server│◄─────────────────────────│
│                                    │ Y.Doc :3913 │                          │
│                                    └─────────────┘                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Y.Doc Instance Count

| Location        | Y.Doc Count | Notes                          |
| --------------- | ----------- | ------------------------------ |
| Phone browser   | 1           | Client only (no local server)  |
| Laptop browser  | 1           | Connects to localhost          |
| Desktop browser | 1           | Connects to localhost          |
| Laptop server   | 1           | Sync node                      |
| Desktop server  | 1           | Sync node                      |
| Cloud server    | 1           | Sync node (optional)           |
| **Total**       | **5-6**     | All stay in sync via providers |

## Sync Node Configuration

Define your sync nodes as a constant for easy reference:

```typescript
// src/config/sync-nodes.ts

/**
 * Registry of all sync nodes in your network.
 *
 * Each entry is a WebSocket URL to an Elysia server running the sync plugin.
 * Use Tailscale hostnames for local network devices.
 */
export const SYNC_NODES = {
	// Local devices via Tailscale
	desktop: 'ws://desktop.my-tailnet.ts.net:3913/rooms/{id}',
	laptop: 'ws://laptop.my-tailnet.ts.net:3913/rooms/{id}',

	// Cloud server (optional, always-on)
	cloud: 'wss://sync.myapp.com/rooms/{id}',

	// Localhost (for browser connecting to local server)
	localhost: 'ws://localhost:3913/rooms/{id}',
} as const;

export type SyncNodeId = keyof typeof SYNC_NODES;
```

## Provider Strategy Per Device

Different devices need different provider configurations.

### Quick Reference Table

| Device              | Acts As         | Providers (Connects To)                                       | Rationale                                       |
| ------------------- | --------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| **Phone browser**   | Client only     | `SYNC_NODES.desktop`, `SYNC_NODES.laptop`, `SYNC_NODES.cloud` | No local server; connect to all available nodes |
| **Laptop browser**  | Client          | `SYNC_NODES.localhost`                                        | Server handles cross-device sync                |
| **Desktop browser** | Client          | `SYNC_NODES.localhost`                                        | Server handles cross-device sync                |
| **Laptop server**   | Server + Client | `SYNC_NODES.desktop`, `SYNC_NODES.cloud`                      | Sync with OTHER servers (not itself)            |
| **Desktop server**  | Server + Client | `SYNC_NODES.laptop`, `SYNC_NODES.cloud`                       | Sync with OTHER servers (not itself)            |
| **Cloud server**    | Server only     | (none)                                                        | Accepts connections; doesn't initiate           |

### Key Insight

- **Browsers** on laptop/desktop only connect to `localhost`. Their local server handles all cross-device sync.
- **Servers** connect to OTHER servers (never themselves). This creates server-to-server sync.
- **Phone** has no server, so it connects directly to all available sync nodes for resilience.

### Phone Browser Configuration

Phone has no local server, so it connects directly to all available sync nodes. Each `attachSync` opens its own WebSocket to a different node.

```typescript
// phone/src/client.ts
import {
	attachIndexedDb,
	attachSync,
	attachTables,
	defineDocument,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { SYNC_NODES } from './config/sync-nodes';
import { blogTables } from './workspace/definition';

const blog = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, blogTables);
	const idb = attachIndexedDb(ydoc);
	// Connect to ALL sync nodes for maximum resilience
	const syncDesktop = attachSync(ydoc, { url: SYNC_NODES.desktop, waitFor: idb.whenLoaded });
	const syncLaptop = attachSync(ydoc, { url: SYNC_NODES.laptop, waitFor: idb.whenLoaded });
	const syncCloud = attachSync(ydoc, { url: SYNC_NODES.cloud, waitFor: idb.whenLoaded });
	return { id, ydoc, tables, idb, syncDesktop, syncLaptop, syncCloud, /* ... */ };
});

export const blogWorkspace = blog.open('blog');
```

### Laptop/Desktop Browser Configuration

Browser connects only to its own local server (localhost). The server handles cross-device sync.

```typescript
// desktop/browser/src/client.ts
const blog = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, blogTables);
	const idb = attachIndexedDb(ydoc);
	// Browser only needs to connect to its local server
	const sync = attachSync(ydoc, { url: SYNC_NODES.localhost, waitFor: idb.whenLoaded });
	return { id, ydoc, tables, idb, sync, /* ... */ };
});

export const blogWorkspace = blog.open('blog');
```

### Desktop Server Configuration (Server-to-Server Sync)

The server acts as BOTH:

1. A sync server (accepts connections via `createSyncPlugin`)
2. A sync client (connects to other servers via `attachSync`)

```typescript
// desktop/server/src/client.ts
const blog = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, blogTables);
	const sqlite = attachSqlite(ydoc, { filePath: '...' });
	// Connect to OTHER sync nodes (not itself!) — Desktop connects to laptop + cloud
	const syncToLaptop = attachSync(ydoc, { url: SYNC_NODES.laptop, waitFor: sqlite.whenLoaded });
	const syncToCloud  = attachSync(ydoc, { url: SYNC_NODES.cloud,  waitFor: sqlite.whenLoaded });
	return { id, ydoc, tables, sqlite, syncToLaptop, syncToCloud, /* ... */ };
});

export const blogWorkspace = blog.open('blog');
```

### Laptop Server Configuration

```typescript
// laptop/server/src/client.ts
const blog = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, blogTables);
	const sqlite = attachSqlite(ydoc, { filePath: '...' });
	// Laptop connects to: desktop + cloud
	const syncToDesktop = attachSync(ydoc, { url: SYNC_NODES.desktop, waitFor: sqlite.whenLoaded });
	const syncToCloud   = attachSync(ydoc, { url: SYNC_NODES.cloud,   waitFor: sqlite.whenLoaded });
	return { id, ydoc, tables, sqlite, syncToDesktop, syncToCloud, /* ... */ };
});

export const blogWorkspace = blog.open('blog');
```

### Cloud Server Configuration

Cloud server typically only accepts connections (doesn't initiate) — no `attachSync` calls at all, only `createSyncPlugin` on the Elysia side.

```typescript
// cloud/src/client.ts
const blog = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, blogTables);
	const sqlite = attachSqlite(ydoc, { filePath: '...' });
	return { id, ydoc, tables, sqlite, /* ... */ };
});

export const blogWorkspace = blog.open('blog');
```

## Data Flow Examples

### Scenario 1: Phone Edits While All Devices Online

```
1. Phone edits document
2. Update sent to desktop server (via WebSocket)
3. Desktop server:
   - Applies update to its Y.Doc
   - Broadcasts to desktop browser
   - Sends to laptop server (server-to-server)
   - Sends to cloud server (server-to-server)
4. Laptop server:
   - Applies update
   - Broadcasts to laptop browser
5. All 6 Y.Docs now have the update
```

### Scenario 2: Desktop Browser Edits Offline

```
1. Desktop browser edits while offline
2. Update stored in IndexedDB (via y-indexeddb)
3. Desktop browser reconnects
4. Update sent to localhost (desktop server)
5. Desktop server broadcasts to all connected clients/servers
6. All devices converge
```

### Scenario 3: Two Devices Edit Simultaneously

```
1. Phone edits "Hello"
2. Laptop browser edits "World"
3. Both updates propagate through network
4. Yjs CRDTs merge automatically
5. All devices see "Hello World" (or merged result)
```

## Offline Support

Each device should also use local persistence:

```typescript
import {
	attachIndexedDb,
	attachSync,
	attachTables,
	defineDocument,
} from '@epicenter/workspace';
import * as Y from 'yjs';

const blog = defineDocument((id: string) => {
	const ydoc = new Y.Doc({ guid: id });
	const tables = attachTables(ydoc, blogTables);
	// Local persistence (use attachSqlite on Node.js)
	const idb = attachIndexedDb(ydoc);
	// Network sync — waits for local replay so the first exchange is a delta
	const sync = attachSync(ydoc, { url: SYNC_NODES.desktop, waitFor: idb.whenLoaded });
	return { id, ydoc, tables, idb, sync, /* ... */ };
});
```

When offline:

1. Changes saved to IndexedDB/filesystem
2. When back online, Yjs syncs missed updates
3. CRDTs ensure consistent merge

## Tailscale Integration

[Tailscale](https://tailscale.com/) provides a private mesh VPN that makes all your devices directly reachable:

- **No port forwarding**: Devices get stable hostnames like `desktop.my-tailnet.ts.net`
- **End-to-end encryption**: WireGuard tunnels between devices
- **Works anywhere**: Home, office, cellular; devices always reachable

```typescript
// With Tailscale, use hostnames instead of IPs
const SYNC_NODES = {
	desktop: 'ws://desktop.my-tailnet.ts.net:3913/rooms/{id}', // Tailscale hostname
	laptop: 'ws://laptop.my-tailnet.ts.net:3913/rooms/{id}', // Tailscale hostname
	cloud: 'wss://sync.myapp.com/rooms/{id}', // Public domain
} as const;
```

## Monitoring and Debugging

### Connection Status

```typescript
import { WebsocketProvider } from 'y-websocket';

const provider = new WebsocketProvider(url, roomId, doc);

provider.on('status', ({ status }) => {
	console.log(`Connection to ${url}: ${status}`);
	// 'connecting' | 'connected' | 'disconnected'
});

provider.on('sync', (isSynced) => {
	console.log(`Synced with ${url}: ${isSynced}`);
});
```

### Check Y.Doc State

```typescript
// See current document state
console.log(doc.toJSON());

// See client ID (unique per Y.Doc instance)
console.log(doc.clientID);

// See state vector (what this doc has seen)
console.log(Y.encodeStateVector(doc));
```

## Summary

| Component            | Purpose                                     |
| -------------------- | ------------------------------------------- |
| **SYNC_NODES**       | Constant defining all sync endpoints        |
| **websocketSync**    | Creates a provider for one sync node        |
| **Multi-provider**   | Connect to multiple nodes simultaneously    |
| **Server-to-server** | Servers sync with each other as clients     |
| **Tailscale**        | Private network for device-to-device access |
| **persistence**      | Local persistence for offline support       |

The architecture scales from "just my devices on Tailscale" to "add a cloud server later" without fundamental changes. Start simple and add providers as needed.

---

# Inside `attachSync`: sync, presence, and RPC

Everything above describes the *topology*: which devices talk to which sync nodes. This section describes the current split runtime surface: `attachSync` owns the WebSocket lifecycle, then callers opt into presence and RPC through `sync.attachPresence({ peer })` and `sync.attachRpc(actions)`.

Understanding the supervisor is the difference between "WebSocket reconnection just works" and being able to debug "why is my CLI hanging." Presence and RPC ride on the same socket, but they are explicit sibling attachments so a sync-only workspace does not pretend to expose peer lookup or remote actions.

## What `attachSync` does at construction

The base sync attachment does four jobs (in `packages/workspace/src/document/attach-sync.ts`):

```
attachSync(doc, { url, getToken, waitFor: idb })
        │
        ├── 1. Pick the Y.Doc from a doc or doc bundle
        │
        ├── 2. Wait for optional persistence hydration
        │
        ├── 3. Start the WebSocket supervisor loop
        │
        └── 4. Return attachment methods:
               status, whenConnected, goOffline, reconnect,
               attachPresence({ peer }), attachRpc(actions)
```

The function returns synchronously. The first connect happens asynchronously after `waitFor` resolves (typically `idb.whenLoaded`).

Presence attaches later:

```ts
const presence = sync.attachPresence({
	peer: { id: 'macbook-pro', name: 'MacBook Pro', platform: 'node' },
});
```

RPC attaches later:

```ts
const rpc = sync.attachRpc(workspace.actions);
```

## Layer split: doc factory vs runtime wrapper

```
┌─────────────────────────────────────────────────────────┐
│  client.ts          (singleton + lifecycle)             │
│  ─ resolves device descriptor                           │
│  ─ wires auth, calls openXxx(...)                       │
│  ─ exports the workspace binding                        │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  browser.ts/extension.ts   (runtime wrapper)            │
│  ─ adds idb (persistence)                               │
│  ─ adds broadcastChannel (cross-tab)                    │
│  ─ adds sync (network + presence + RPC)                 │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  index.ts           (doc factory — pure)                │
│  ─ ydoc, encryption, tables, kv, actions                │
│  ─ no network, no auth, no platform                     │
└─────────────────────────────────────────────────────────┘
```

The wrapper takes the doc bundle and wires sync, presence, and RPC for that runtime. The doc factory has no awareness, no sync, no platform concerns.

## The dispatch tree

Pretend an app exposes:

```ts
userActions = {
  tabs: {
    close: defineMutation({...}),
    list:  defineQuery({...}),
  },
  bookmarks: {
    create: defineMutation({...}),
  },
}
```

After `sync.attachRpc(userActions)` runs:

```
actions = {
  tabs:                 ┐
    close                 ← USER (yours)
    list                ┘
  bookmarks:
    create
  system:               ┐
    describe              ← SYSTEM (runtime-injected)
                        ┘
}
```

User and system actions are **structurally identical**: both built with `defineQuery`/`defineMutation`, both reachable via `rpc.rpc(target, '<path>', ...)`. The dispatcher (`resolveActionPath`) doesn't distinguish.

The only thing that separates them is the reservation: a top-level `system` key in *your* actions throws at construction. The reservation is shallow (only top-level), follows JSON-RPC's `rpc.*` precedent, and the snapshot is taken at attach time — post-attach mutations to `userActions` don't affect dispatch.

## Awareness vs RPC: what's where

This is the architectural split worth memorizing:

```
AWARENESS                          RPC
─────────                          ───
Always-on broadcast                Request/response
Every ~15s rebroadcast             Once per call
Presence only                      Capability + dispatch
~150 bytes/peer                    Whatever you send
30s TTL (auto-cleanup)             Per-call timeout

"Who's online?"                    "Hey, do this"
"What's their identity?"           "What can you do?" (system.describe)
                                   "Close these tabs" (user actions)
```

Awareness carries `{id, name, platform}` only. The action manifest moved to `system.describe` — fetched on demand instead of broadcast every 15s. The trip-wire was N²·M wire traffic; the fix was on-demand RPC.

## The supervisor loop and its timers

`attachSync` runs ONE loop that owns the WebSocket. Six timers participate:

```
                    ┌──────────────────────────────┐
                    │   SUPERVISOR LOOP            │
                    │   while (desired==='online') │
                    └──────────────┬───────────────┘
                                   │
                       ┌───────────▼───────────┐
                       │  CONNECT_TIMEOUT_MS   │
                       │       15_000          │
                       │  if not OPEN by then, │
                       │  ws.close()           │
                       └───────────┬───────────┘
                                   │ open
                       ┌───────────▼───────────┐
                       │   handshake           │  ← STEP1 → STEP2 → resolveConnected()
                       └───────────┬───────────┘
                                   │
        ┌──────────────────────────▼──────────────────────────┐
        │  CONNECTED — four timers run in parallel             │
        ├──────────────────────────────────────────────────────┤
        │                                                      │
        │  PING_INTERVAL_MS = 60_000                           │
        │   every 60s: ws.send('ping')                         │
        │   keeps NAT/proxy alive                              │
        │                                                      │
        │  LIVENESS_CHECK_INTERVAL_MS = 10_000                 │
        │   every 10s: if Date.now() - lastMsg > 90_000        │
        │              ws.close()  ← server is dead            │
        │                                                      │
        │  syncStatusTimer = 100ms (debounce)                  │
        │   after a doc-update burst, send SYNC_STATUS once    │
        │   instead of per-keystroke                           │
        │                                                      │
        │  RPC timers (per outbound call)                      │
        │   default DEFAULT_RPC_TIMEOUT_MS = 5_000             │
        │   if no response by then → RpcError.Timeout          │
        │                                                      │
        └──────────────────────────┬───────────────────────────┘
                                   │ ws.onclose
                       ┌───────────▼───────────┐
                       │   BACKOFF             │
                       │  base 500ms           │
                       │  × 2^retries          │
                       │  capped at 30_000     │
                       │  jittered 0.5–1.0     │
                       └───────────┬───────────┘
                                   │
                                   └──→ back to top
```

Constants in plain English:

| Constant | Value | What it does |
|---|---|---|
| `CONNECT_TIMEOUT_MS` | 15s | Give up on a half-open WebSocket |
| `PING_INTERVAL_MS` | 60s | Send `'ping'` to keep the connection warm |
| `LIVENESS_TIMEOUT_MS` | 90s | If no message arrived in this long, declare the server dead |
| `LIVENESS_CHECK_INTERVAL_MS` | 10s | How often we evaluate the 90s rule |
| `DEFAULT_RPC_TIMEOUT_MS` | 5s | Per-call timeout for an outbound RPC |
| `BASE_DELAY_MS` / `MAX_DELAY_MS` | 500ms / 30s | Reconnect backoff bounds |
| `syncStatusTimer` | 100ms | Debounce for batching SYNC_STATUS frames |

## The cancellation thread (`AbortController`)

The single load-bearing safety property in the loop is a pair of linked
controllers:

```txt
masterController
  └─ cycleController
```

`masterController` aborts when the Y.Doc is destroyed. That kills every current
and future connection cycle.

`cycleController` aborts when `goOffline()` or `reconnect()` changes the current
connection intent. `reconnect()` replaces it with a fresh child controller before
starting the supervisor again, so a stale await cannot open a socket for an old
cycle.

After awaited boundaries, the loop checks that the captured signal is still the
current cycle signal. Without this thread, a stale token from an awaited
`getToken()` could be used to open a connection after the user asked to close, or
two supervisor loops could run at the same time after a reconnect during
handshake.

## Lifecycle promises

| Promise | Resolves when | Rejects when |
|---|---|---|
| `whenConnected` | First successful handshake (STEP2 or UPDATE arrives) | Doc destroyed before first handshake (permanent failure) |
| `whenDisposed` | Supervisor exits AND WebSocket reaches CLOSED (or 1s safety timeout fires) | Never |

`whenConnected` was previously "may hang forever" — fixed to reject on dispose so CLIs that `await sync.whenConnected` get a useful failure instead of a wedge.

## RPC: peer dispatch surface

Presence is the source of truth for "who else is here"; RPC is the dispatch surface:

```ts
presence.peers()                       // Map<clientId, PeerAwarenessState>
presence.find(peerId)                  // Resolved peer or undefined
presence.observe(callback)             // unsubscribe fn
rpc.rpc(target, action, input, opts)   // typed remote call
```

Cross-device action call:

```ts
const macbook = createRemoteActions<TabManagerActions>(
	{
		presence: fuji.presence,
		rpc: fuji.rpc,
	},
	'macbook-pro',
);
const result = await macbook.tabs.close({ tabIds: [1, 2] });
```

`createRemoteActions<T>({ presence, rpc }, peerId)` returns a typed Proxy. Walking `.tabs.close` builds nested proxies; calling `.tabs.close(input)` resolves the peer through presence and dispatches via `rpc.rpc(clientId, 'tabs.close', input)`.

`describeRemoteActions({ presence, rpc }, peerId)` is a thin wrapper that calls the injected `system.describe` action to fetch the peer's full action manifest on demand.

### Peer-removed race semantics

Both `createRemoteActions<T>` and `describeRemoteActions` race the RPC against a peer-removed signal. If the matched peer disappears mid-call, the in-flight Promise rejects immediately with `RpcError.PeerLeft` rather than waiting the full RPC timeout:

```
createRemoteActions<T>({ presence, rpc }, 'mac').foo()
  │
  ├─ subscribe to presence.observe(callback)
  ├─ fire: rpc.rpc(...)
  │
  ├─ if RPC resolves first:        → return its result
  ├─ if peer leaves awareness first → reject with PeerLeft
  └─ either way: unsubscribe
```

## A full call: `epicenter list --peer macbook-pro`

End-to-end. The CLI process is "Fuji"; the peer is "macbook-pro" (a tab-manager instance).

```
┌────────────────────┐                     ┌────────────────────┐
│  Fuji (CLI)        │                     │  macbook-pro       │
│  workspace.sync    │                     │  (tab-manager)     │
└─────────┬──────────┘                     └─────────┬──────────┘
          │                                          │
          │ 1. CLI loads epicenter.config.ts         │
          │    workspace.presence.peers() returns:   │
          │    Map { 42 → {peer:{id:'macbook-pro'}}}│
          │                                          │
          │ 2. describeRemoteActions({...}, peerId)  │
          │    → system.describe()                   │
          │                                          │
          │ 3. internally: presence.find(peerId)     │
          │    returns { clientId: 42, state }       │
          │                                          │
          │ 4. rpc.rpc(42, 'system.describe',        │
          │            undefined)                    │
          │                                          │
          │    ─── encodeRpcRequest ───────────►     │
          │                                          │
          │    [waits up to 5s, RPC timer running]   │
          │                                          │ 5. ws.onmessage
          │                                          │    decodes RPC request
          │                                          │
          │                                          │ 6. resolveActionPath(
          │                                          │      actions,
          │                                          │      'system.describe')
          │                                          │
          │                                          │ 7. handler runs:
          │                                          │    describeActions(userActions)
          │                                          │    → ActionManifest
          │                                          │
          │   ◄──── encodeRpcResponse ────────────   │
          │                                          │
          │ 8. ws.onmessage matches requestId in     │
          │    pendingRequests, resolves the         │
          │    Promise with Ok(manifest)             │
          │                                          │
          │ 9. CLI renders the manifest as a tree    │
          │                                          │
```

## Construction → first connect, in time

```
t=0ms      attachSync(doc, { url, getToken, waitFor: idb })
              ├─ wires ydoc.on('updateV2')
              └─ kicks off async waitFor → ensureSupervisor()

              returns SyncAttachment immediately

t=0ms      sync.attachPresence({ peer })
              └─ publishes local peer state when the socket opens

t=0ms      sync.attachRpc(actions)
              ├─ validates `'system' not in userActions`
              └─ injects system.describe

t=~10ms    idb.whenLoaded resolves (typical hot start)

t=~10ms    supervisor: getToken() → token
           supervisor: new WebSocket(url, [main, bearer.<token>])

           [CONNECT_TIMEOUT_MS = 15s timer running]

t=~50ms    ws.onopen
           send STEP1
           start liveness monitor

t=~80ms    ws.onmessage: STEP2 from server
           handshakeComplete = true
           status: { phase: 'connected', hasLocalChanges }
           resolveConnected()

t=80ms+    [from here on, four loops run forever:]
            • PING every 60s
            • LIVENESS check every 10s (90s threshold)
            • per-RPC 5s timers as calls happen
            • per-doc-update-burst SYNC_STATUS at 100ms quiet
```

## Mental model in one paragraph

`attachSync(doc, config)` is the wire and the supervisor. Presence and RPC are explicit attachments riding on that wire: `sync.attachPresence({ peer })` publishes routable identity, and `sync.attachRpc(actions)` builds the dispatch tree `{ ...userActions, system: { describe } }` with `system.*` reserved. Awareness is identity-only (~150B/peer, broadcast every 15s, 30s TTL). RPC is capability and dispatch (request/response, timeout, racing against peer-removed). Remote proxies use `{ presence, rpc }`, not a monolithic sync object.
