# Epicenter Sync

Client-side Yjs sync provider for `@epicenter/server-local`.

## What This Does

`createSyncProvider()` connects a `Y.Doc` to a WebSocket sync server using the y-websocket protocol, plus a custom heartbeat extension (MESSAGE_SYNC_STATUS, tag 102) for `hasLocalChanges` tracking and fast dead-connection detection.

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

// Track whether local changes have reached the server:
provider.onLocalChanges((hasChanges) => {
	console.log(hasChanges ? 'Saving...' : 'Saved');
});

// Clean up when done:
provider.destroy();
```

## Auth Modes

Two authentication modes, matching `@epicenter/server-local`'s auth configuration:

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

The provider caches the token and refreshes it after every 3 consecutive connection failures.

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
| `getToken`             | `() => Promise<string>` | —                    | Dynamic token fetcher for authenticated mode                    |
| `connect`              | `boolean`               | `true`               | Whether to connect immediately                                  |
| `awareness`            | `Awareness`             | `new Awareness(doc)` | External awareness instance for user presence                   |

**Returns `SyncProvider`:**

| Property / Method    | Type                                                     | Description                                            |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| `status`             | `SyncStatus` (readonly)                                  | Current connection status (discriminated on `phase`)   |
| `hasLocalChanges`    | `boolean` (readonly)                                     | Whether unacknowledged local changes exist             |
| `awareness`          | `Awareness` (readonly)                                   | The awareness instance for user presence               |
| `connect()`          | `() => void`                                             | Start connecting. Idempotent.                          |
| `disconnect()`       | `() => void`                                             | Stop connecting and close the socket                   |
| `onStatusChange(fn)` | `(listener: (status: SyncStatus) => void) => () => void` | Subscribe to status changes. Returns unsubscribe.      |
| `onLocalChanges(fn)` | `(listener: (has: boolean) => void) => () => void`       | Subscribe to local changes state. Returns unsubscribe. |
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

## `hasLocalChanges`

Tracks whether all local Y.Doc mutations have been acknowledged by the server.

The provider sends a MESSAGE_SYNC_STATUS (tag 102) frame after each local edit containing a monotonic version counter. The server echoes it back unchanged. When the echoed version matches the local version, all changes have reached the server.

This powers "Saving..." / "Saved" UI indicators and `beforeunload` warnings:

```typescript
provider.onLocalChanges((hasChanges) => {
	statusBar.text = hasChanges ? 'Saving...' : 'Saved';
});

window.addEventListener('beforeunload', (e) => {
	if (provider.hasLocalChanges) {
		e.preventDefault();
	}
});
```

## Heartbeat

The same MESSAGE_SYNC_STATUS message doubles as a heartbeat probe:

- After **2 seconds** of silence (no messages sent or received), the provider sends a probe
- If no response arrives within **3 seconds**, the WebSocket is closed and reconnection begins
- Worst-case dead connection detection: **5 seconds**

The heartbeat timeout only arms after the server has responded to at least one probe (proving it supports tag 102). This prevents false-positive disconnects from standard y-websocket servers.

Browser `offline` events trigger an immediate probe. Browser `online` events wake the reconnect backoff sleeper.

## Architecture

The provider uses a **supervisor loop** architecture:

- One `async` loop owns all status transitions and reconnection decisions
- WebSocket event handlers (`onopen`, `onclose`, `onmessage`) are reporters only — they resolve promises that the loop awaits, but never make reconnection decisions
- Exponential backoff with a wakeable sleeper (woken by browser `online` events)

This eliminates the race conditions common in event-driven WebSocket reconnection logic.

## Relationship to Other Packages

```
@epicenter/workspace                          @epicenter/server-local
 └─ extensions/sync.ts                  └─ sync/ws-plugin.ts (Elysia plugin)
     │                                      │
     │  createSyncExtension()               │  createSyncPlugin()
     │  - URL templating ({id})             │  - WebSocket endpoint
     │  - Waits for persistence             │  - y-websocket protocol
     │  - Lifecycle management              │  - MESSAGE_SYNC_STATUS echo
     │                                      │  - Ping/pong keepalive
     └──── uses ────▶ @epicenter/sync ◀──── talks to ────┘
                      └─ createSyncProvider()
                      └─ Supervisor loop
                      └─ Heartbeat + hasLocalChanges
```

- **`@epicenter/sync`** (this package): Raw sync provider. Connects a Y.Doc to a WebSocket.
- **`@epicenter/server-local`**: The server that this provider connects to. Exposes `ws://host:port/rooms/{id}`.
- **`@epicenter/workspace/extensions/sync`**: Workspace extension wrapper. Most consumers use this instead of the raw provider.
