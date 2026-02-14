# @epicenter/sync

Client-side Yjs sync provider for `@epicenter/server`.

Connects a `Y.Doc` to a WebSocket sync server using the y-websocket protocol, extended with `MESSAGE_SYNC_STATUS` (tag 102) for `hasLocalChanges` tracking and fast dead-connection detection.

## When to Use This Directly

Most consumers should use `createSyncExtension` from `@epicenter/hq/extensions/sync`, which wraps this provider with extension lifecycle management (waiting for persistence to load before connecting, etc.).

Use `createSyncProvider` directly when you need low-level control — custom connection timing, multiple providers on the same doc, or non-Epicenter Yjs applications.

## Quick Start

```typescript
import { createSyncProvider } from '@epicenter/sync';
import * as Y from 'yjs';

const doc = new Y.Doc();

const provider = createSyncProvider({
	doc,
	url: 'ws://localhost:3913/workspaces/blog/sync',
});

// provider.status → 'connecting' → 'handshaking' → 'connected'
// provider.hasLocalChanges → true while edits haven't been acked
```

## Auth Modes

### Mode 1: Open (no auth)

For localhost, Tailscale, LAN — any trusted network.

```typescript
const provider = createSyncProvider({
	doc,
	url: 'ws://localhost:3913/workspaces/blog/sync',
});
```

### Mode 2: Static Token

A shared secret passed as a query parameter.

```typescript
const provider = createSyncProvider({
	doc,
	url: 'ws://my-server:3913/workspaces/blog/sync',
	token: 'my-shared-secret',
});
```

### Mode 3: Dynamic Token

A function called on each connect/reconnect. Useful for JWTs that expire.

```typescript
const provider = createSyncProvider({
	doc,
	url: 'wss://sync.epicenter.so/workspaces/blog/sync',
	getToken: async () => {
		const res = await fetch('/api/sync/token');
		return (await res.json()).token;
	},
});
```

The provider caches the token and refreshes it after several failed connection attempts.

## API

### `createSyncProvider(config): SyncProvider`

Creates and returns a sync provider instance.

#### Config (`SyncProviderConfig`)

| Option                 | Type                    | Default              | Description                                                     |
| ---------------------- | ----------------------- | -------------------- | --------------------------------------------------------------- |
| `doc`                  | `Y.Doc`                 | _required_           | The Yjs document to sync                                        |
| `url`                  | `string`                | _required_           | WebSocket URL to connect to                                     |
| `token`                | `string`                | —                    | Static auth token (Mode 2). Mutually exclusive with `getToken`  |
| `getToken`             | `() => Promise<string>` | —                    | Dynamic token fetcher (Mode 3). Mutually exclusive with `token` |
| `connect`              | `boolean`               | `true`               | Whether to connect immediately                                  |
| `awareness`            | `Awareness`             | `new Awareness(doc)` | External awareness instance for user presence                   |
| `WebSocketConstructor` | `WebSocketConstructor`  | `WebSocket`          | WebSocket implementation override (for testing or Node.js)      |

#### Return Value (`SyncProvider`)

| Property / Method          | Type                 | Description                                                     |
| -------------------------- | -------------------- | --------------------------------------------------------------- |
| `status`                   | `SyncStatus`         | Current connection status (readonly)                            |
| `hasLocalChanges`          | `boolean`            | Whether unacked local edits exist (readonly)                    |
| `awareness`                | `Awareness`          | The awareness instance for user presence (readonly)             |
| `connect()`                | `() => void`         | Start connecting. Idempotent                                    |
| `disconnect()`             | `() => void`         | Stop connecting and close the socket                            |
| `onStatusChange(listener)` | `(cb) => () => void` | Subscribe to status changes. Returns unsubscribe                |
| `onLocalChanges(listener)` | `(cb) => () => void` | Subscribe to `hasLocalChanges` transitions. Returns unsubscribe |
| `destroy()`                | `() => void`         | Clean up everything. Provider is unusable after this            |

## Connection Status Model

Five states (vs y-websocket's three):

```
offline → connecting → handshaking → connected
                ↑            |            |
                |            v            v
                └────────── error ←───────┘
```

| Status        | Meaning                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| `offline`     | Not connected, not trying. Set by `disconnect()` or initial state when `connect: false` |
| `connecting`  | Attempting to open a WebSocket (or acquiring a token)                                   |
| `handshaking` | WebSocket open, Yjs sync step 1/2 exchange in progress                                  |
| `connected`   | Fully synced and communicating                                                          |
| `error`       | Connection failed. Will retry after exponential backoff                                 |

## `hasLocalChanges`

Tracks whether local edits have been acknowledged by the server.

```typescript
provider.onLocalChanges((hasChanges) => {
	statusBar.text = hasChanges ? 'Saving...' : 'Saved';
});
```

This works via the `MESSAGE_SYNC_STATUS` (tag 102) protocol extension:

1. On each local Y.Doc edit, the provider bumps a `localVersion` counter
2. Sends a `[102][localVersion]` message to the server
3. The server echoes the bytes back unchanged (zero-cost, never parsed)
4. When the echoed version matches `localVersion`, all changes are confirmed

The same mechanism doubles as a heartbeat — if the echo doesn't arrive within 3 seconds, the connection is presumed dead.

## Reconnection

The provider uses a supervisor loop architecture:

- One loop owns all status transitions and reconnection decisions
- Event handlers (onclose, onerror, heartbeat timeout) only resolve promises the loop awaits
- Exponential backoff with a wakeable sleeper (woken immediately by browser `online` events)
- After several failed retries, the token is refreshed (Mode 3 auth)

## Heartbeat

| Event                                     | Action                                                    |
| ----------------------------------------- | --------------------------------------------------------- |
| No messages received for **2 seconds**    | Client sends `MESSAGE_SYNC_STATUS`, arms 3-second timeout |
| Any response arrives within **3 seconds** | Timeout cleared, idle timer reset                         |
| No response within **3 seconds**          | WebSocket closed, supervisor loop reconnects              |
| Browser reports `offline`                 | Immediate probe (doesn't blindly trust the event)         |
| Browser reports `online`                  | Wakes backoff sleeper for instant reconnect               |

Worst-case dead-connection detection: **5 seconds** (2s idle + 3s timeout).

The timeout is only armed after the server has responded to at least one `MESSAGE_SYNC_STATUS`, so connecting to a standard y-websocket server that doesn't understand tag 102 won't cause false disconnects.

## Relationship to Other Packages

- **`@epicenter/server`** — The server that exposes the WebSocket sync endpoint at `/workspaces/{id}/sync`. It handles the y-websocket protocol, echoes `MESSAGE_SYNC_STATUS`, and manages rooms with ping/pong keepalive.
- **`@epicenter/hq`** — The workspace library. Its `createSyncExtension` (from `@epicenter/hq/extensions/sync`) wraps `createSyncProvider` with extension lifecycle — waiting for persistence to load, resolving URL placeholders, and providing `reconnect()` for switching sync targets.
