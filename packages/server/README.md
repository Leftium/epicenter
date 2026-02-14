# Epicenter Server

Expose your workspace tables as REST APIs and WebSocket sync endpoints.

## What This Does

`createServer()` wraps workspace clients and:

1. **Takes initialized clients** (single or array)
2. **Keeps them alive** (doesn't dispose until you stop the server)
3. **Maps HTTP endpoints** to tables (REST CRUD, WebSocket sync)

The key difference from running scripts:

- **Scripts**: Client is alive only during the `using` block, then auto-disposed
- **Server**: Clients stay alive until you manually stop the server (Ctrl+C)

## Quick Start

```typescript
import { defineWorkspace, createServer, id, text } from '@epicenter/hq/dynamic';
import { sqlite } from '@epicenter/hq/extensions';

// 1. Define workspace
const blogWorkspace = defineWorkspace({
	id: 'blog',
	tables: {
		posts: { id: id(), title: text() },
	},
});

// 2. Create client
const blogClient = await blogWorkspace.withProviders({ sqlite }).create();

// 3. Create and start server
const server = createServer(blogClient, { port: 3913 });
server.start();
```

Now your tables are available as REST endpoints:

- `GET http://localhost:3913/workspaces/blog/tables/posts`
- `POST http://localhost:3913/workspaces/blog/tables/posts`

## API

### `createServer(client, options?)` or `createServer(clients, options?)`

**Signatures:**

```typescript
function createServer(client: WorkspaceClient, options?: ServerOptions): Server;
function createServer(
	clients: WorkspaceClient[],
	options?: ServerOptions,
): Server;

type ServerOptions = {
	port?: number; // Default: 3913
};
```

**Usage:**

```typescript
// Single workspace
createServer(blogClient);
createServer(blogClient, { port: 8080 });

// Multiple workspaces (array - IDs from workspace definitions)
createServer([blogClient, authClient]);
createServer([blogClient, authClient], { port: 8080 });
```

**Why array, not object?**

- Workspace IDs come from `defineWorkspace({ id: 'blog' })`
- No redundancy (don't type 'blog' twice)
- Less error-prone (can't mismatch key and workspace ID)

### Server Methods

```typescript
const server = createServer(blogClient, { port: 3913 });

server.app; // Underlying Elysia instance
server.start(); // Start the HTTP server
await server.destroy(); // Stop server and cleanup all clients
```

## Multiple Workspaces

```typescript
const blogClient = await blogWorkspace.withProviders({ sqlite }).create();
const authClient = await authWorkspace.withProviders({ sqlite }).create();

// Pass array of clients
const server = createServer([blogClient, authClient], { port: 3913 });
server.start();
```

Routes are namespaced by workspace ID:

- `/workspaces/blog/tables/posts`
- `/workspaces/auth/tables/users`

## URL Hierarchy

```
/                                              - API root/discovery
/openapi                                       - Scalar UI documentation
/openapi/json                                  - OpenAPI spec (JSON)
/workspaces/{workspaceId}/sync                 - WebSocket sync (y-websocket protocol)
/workspaces/{workspaceId}/tables/{table}       - RESTful table CRUD
/workspaces/{workspaceId}/tables/{table}/{id}  - Single row operations
```

## WebSocket Sync

The server includes a y-websocket compatible sync endpoint for real-time Y.Doc synchronization. This is the primary feature for multi-device collaboration.

### Client Connection

Clients connect via WebSocket to:

```
ws://host:3913/workspaces/{workspaceId}/sync
```

The recommended client is `@epicenter/sync`, which provides `createSyncProvider` with automatic reconnection, heartbeat, and `hasLocalChanges` tracking. Most Epicenter consumers use `createSyncExtension` from `@epicenter/hq/extensions/sync`, which wraps the provider with extension lifecycle management.

### Protocol Messages

The server handles four y-websocket message types:

| Tag | Name              | Description                                                                                  |
| --- | ----------------- | -------------------------------------------------------------------------------------------- |
| 0   | `SYNC`            | Document synchronization (sync step 1, sync step 2, update)                                  |
| 1   | `AWARENESS`       | User presence — cursor positions, names, selection state. Broadcast to all peers in the room |
| 3   | `QUERY_AWARENESS` | Client requests current awareness states from the server                                     |
| 102 | `SYNC_STATUS`     | Heartbeat and change-tracking extension (see below)                                          |

### MESSAGE_SYNC_STATUS (102)

An extension beyond the standard y-websocket protocol. The client sends its `localVersion` as a varint payload. The server echoes the raw bytes back unchanged — zero parsing, zero cost. This enables:

- **`hasLocalChanges`** on the client — compare acked version vs local version to show "Saving..." / "Saved"
- **Fast heartbeat** — 2s idle probe + 3s timeout = 5s dead-connection detection

### Server-Side Keepalive

The server runs ping/pong keepalive independently of the 102 heartbeat:

- Sends a WebSocket `ping` every **30 seconds**
- If no `pong` arrives before the next ping, the connection is closed
- Detects dead clients (laptop lid closed, browser killed, network drop)

### Room Management

Each workspace ID maps to a room:

- Connections are tracked per room for broadcasting
- Awareness (user presence) is managed per room
- When the last connection leaves, a **60-second eviction timer** starts
- If a new connection joins before eviction, the timer is cancelled
- After eviction, the room and its awareness state are cleaned up

### Server + Client Together

```typescript
import { createServer } from '@epicenter/server';
import { createSyncProvider } from '@epicenter/sync';
import * as Y from 'yjs';

// Server side
const server = createServer(blogClient, { port: 3913 });
server.start();

// Client side
const doc = new Y.Doc();
const provider = createSyncProvider({
	doc,
	url: 'ws://localhost:3913/workspaces/blog/sync',
});
// provider.status → 'connected'
// provider.hasLocalChanges → false (all edits acked)
```

## Server vs Scripts

### Use Scripts (Direct Client)

```typescript
{
	await using client = await blogWorkspace.withProviders({ sqlite }).create();

	client.tables.posts.upsert({ id: '1', title: 'Hello' });
	// Client disposed when block exits
}
```

**Good for:** One-off migrations, data imports, CLI tools, batch processing

**Requirements:** Server must NOT be running in the same directory

### Use Server (HTTP Wrapper)

```typescript
const client = await blogWorkspace.withProviders({ sqlite }).create();

const server = createServer(client, { port: 3913 });
server.start();
// Clients stay alive until Ctrl+C
```

**Good for:** Web applications, API backends, real-time collaboration

### Running Scripts While Server is Active

Use the HTTP API instead of creating another client:

```typescript
// DON'T: Create another client (storage conflict!)
{
	await using client = await blogWorkspace.withProviders({ sqlite }).create();
	client.tables.posts.upsert({ ... });
}

// DO: Use the server's HTTP API
await fetch('http://localhost:3913/workspaces/blog/tables/posts', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ id: '1', title: 'New Post' }),
});
```

## RESTful Tables

Tables are automatically exposed as CRUD endpoints:

| Method   | Path                                          | Description          |
| -------- | --------------------------------------------- | -------------------- |
| `GET`    | `/workspaces/{workspace}/tables/{table}`      | List all valid rows  |
| `GET`    | `/workspaces/{workspace}/tables/{table}/{id}` | Get single row by ID |
| `POST`   | `/workspaces/{workspace}/tables/{table}`      | Create or upsert row |
| `PUT`    | `/workspaces/{workspace}/tables/{table}/{id}` | Update row fields    |
| `DELETE` | `/workspaces/{workspace}/tables/{table}/{id}` | Delete row           |

### Response Format

**Success:**

```json
{ "data": { "id": "123", "title": "Hello" } }
```

**Error:**

```json
{ "error": { "message": "What went wrong" } }
```

## Custom Endpoints

Write regular functions that use your client and expose them via custom routes:

```typescript
const server = createServer(blogClient, { port: 3913 });

// Define functions that use the client
function createPost(title: string) {
	const id = generateId();
	blogClient.tables.posts.upsert({ id, title });
	return { id };
}

// Add custom routes
server.app.post('/api/posts', ({ body }) => createPost(body.title));
server.app.get('/health', () => 'OK');

server.start();
```

## Lifecycle Management

```typescript
const server = createServer([blogClient, authClient], { port: 3913 });

// Start the server
server.start();

// Server handles SIGINT/SIGTERM for graceful shutdown
// Or manually destroy:
await server.destroy(); // Stops server, cleans up all clients
```
