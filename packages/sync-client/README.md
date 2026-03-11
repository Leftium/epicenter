# Epicenter Sync

Client-side Yjs sync provider for any y-websocket compatible server.

## What This Does

`createSyncProvider()` connects a `Y.Doc` to a WebSocket sync server using the y-websocket protocol with text-based ping/pong liveness detection.

Most consumers don't use this package directly. Instead, they use `createSyncExtension` from `@epicenter/workspace/extensions/sync`, which wraps this provider with workspace lifecycle management (waiting for persistence to load before connecting, auto-cleanup on destroy, URL templating with workspace IDs).

Use this package directly when you need raw Y.Doc sync without the workspace extension system.

## Quick Start

```typescript
import { createSyncProvider } from '@epicenter/sync';
import * as Y from 'yjs';

const doc = new Y.Doc();

const provider = createSyncProvider({
	doc,
	url: 'ws://localhost:3913/rooms/my-workspace',
});

// Provider connects automatically. Check status:
provider.onStatusChange((status) => {
	console.log('Sync phase:', status.phase);
});

// Clean up when done:
provider.destroy();
```

## Auth Modes

Two authentication modes:

### Open (no auth)

For localhost, Tailscale, LAN, or development:

```typescript
const provider = createSyncProvider({
	doc,
	url: 'ws://localhost:3913/rooms/blog',
});
```

### Authenticated

A function that fetches a fresh token on each connect/reconnect. For static tokens, wrap them: `getToken: async () => 'my-token'`.

```typescript
const provider = createSyncProvider({
	doc,
	url: 'wss://sync.epicenter.so/rooms/blog',
	getToken: async () => {
		const res = await fetch('/api/sync/token');
		return (await res.json()).token;
	},
});
```

The token is fetched fresh on every connection attempt—no caching.

## API

### `createSyncProvider(config)`

```typescript
function createSyncProvider(config: SyncProviderConfig): SyncProvider;
```

**Config:**

| Option                 | Type                    | Default              | Description                                                     |
| ---------------------- | ----------------------- | -------------------- | --------------------------------------------------------------- |
| `doc`                  | `Y.Doc`                 | (required)           | The Yjs document to sync                                        |
| `url`                  | `string`                | (required)           | WebSocket URL to connect to                                     |
| `getToken`             | `() => Promise<string \| undefined>` | —                    | Dynamic token fetcher for authenticated mode. Return `undefined` when no token is available. |
| `connect`              | `boolean`               | `true`               | Whether to connect immediately                                  |
| `awareness`            | `Awareness`             | `new Awareness(doc)` | External awareness instance for user presence                   |

**Returns `SyncProvider`:**

| Property / Method    | Type                                                     | Description                                            |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| `status`             | `SyncStatus` (readonly)                                  | Current connection status (discriminated on `phase`)   |
| `awareness`          | `Awareness` (readonly)                                   | The awareness instance for user presence               |
| `connect()`          | `() => void`                                             | Start connecting. Idempotent.                          |
| `disconnect()`       | `() => void`                                             | Stop connecting and close the socket                   |
| `onStatusChange(fn)` | `(listener: (status: SyncStatus) => void) => () => void` | Subscribe to status changes. Returns unsubscribe.      |
| `destroy()`          | `() => void`                                             | Disconnect, remove all listeners, release resources    |

## Connection Status Model

Three phases, discriminated as a union on `phase`:

```typescript
type SyncStatus =
  | { phase: 'offline' }
  | { phase: 'connecting'; attempt: number; lastError?: SyncError }
  | { phase: 'connected' }

type SyncError =
  | { type: 'auth'; error: unknown }
  | { type: 'connection' }
```

```
  ┌─────────┐    connect()    ┌────────────┐   handshake   ┌───────────┐
  │ offline │ ──────────────▶ │ connecting │ ────────────▶ │ connected │
  └─────────┘                 └────────────┘               └───────────┘
       ▲                           ▲                            │
       │ disconnect()              │ backoff                    │ ws.close
       │                           │                            │
       │                           └────────────────────────────┘
```

| Phase          | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| `offline`      | Not connected, not trying to connect                            |
| `connecting`   | Opening a WebSocket, fetching a token, or performing handshake. Carries `attempt` (0 = first try) and optional `lastError` from last failure |
| `connected`    | Fully synced and communicating                                  |

The `connecting` phase carries error context so consumers can distinguish auth failures from network failures:

```typescript
provider.onStatusChange((status) => {
  if (status.phase === 'connecting' && status.lastError?.type === 'auth') {
    showMessage('Sign in again');
  }
});
```

## Liveness Detection

The provider sends text `"ping"` messages at a fixed interval. Any incoming message (binary sync data or text `"pong"`) resets the liveness timer. If no message arrives within the timeout window, the WebSocket is closed and reconnection begins.

- **Ping interval**: 30 seconds
- **Liveness timeout**: 45 seconds (checked every 10 seconds)
- **Worst-case dead connection detection**: ~55 seconds

Browser `offline` events close the socket immediately. Browser `online` events wake the reconnect backoff sleeper. Tab visibility changes trigger an immediate ping to detect stale connections.

## Architecture

The provider uses a **supervisor loop** architecture:

- One `async` loop owns all status transitions and reconnection decisions
- WebSocket event handlers (`onopen`, `onclose`, `onmessage`) are reporters only — they resolve promises that the loop awaits, but never make reconnection decisions
- Exponential backoff with a wakeable sleeper (woken by browser `online` events)

This eliminates the race conditions common in event-driven WebSocket reconnection logic.

## Relationship to Other Packages

```
@epicenter/workspace                          Server (any y-websocket)
 └─ extensions/sync.ts                  └─ WebSocket endpoint
     │                                      │
     │  createSyncExtension()               │  y-websocket protocol
     │  - URL templating ({id})             │  Ping/pong keepalive
     │  - Waits for persistence             │
     │  - Lifecycle management              │
     │                                      │
     └──── uses ────▶ @epicenter/sync ◀──── talks to ────┘
                      └─ createSyncProvider()
                      └─ Supervisor loop
                      └─ Liveness (ping/pong)
```

- **`@epicenter/sync`** (this package): Raw sync provider. Connects a Y.Doc to a WebSocket.
- **Server**: Any server exposing `ws://host:port/rooms/{id}` with y-websocket protocol (e.g., `apps/api`).
- **`@epicenter/workspace/extensions/sync`**: Workspace extension wrapper. Most consumers use this instead of the raw provider.
