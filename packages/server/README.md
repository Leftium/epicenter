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

The server's primary real-time feature is WebSocket-based Y.Doc synchronization. Clients connect to sync their local Yjs documents with the server's authoritative copy.

### Client Connection

Clients connect to:

```
ws://host:3913/workspaces/{workspaceId}/sync
```

The recommended client is `@epicenter/sync` (via `createSyncExtension` from `@epicenter/hq/extensions/sync`):

```typescript
import { createSyncExtension } from '@epicenter/hq/extensions/sync';

const client = createClient(definition.id)
  .withDefinition(definition)
  .withExtension('persistence', setupPersistence)
  .withExtension('sync', createSyncExtension({
    url: 'ws://localhost:3913/workspaces/{id}/sync',
  }));
```

### Protocol

The sync plugin implements the y-websocket protocol with one custom extension:

| Message Type          | Tag | Direction          | Purpose                                    |
| --------------------- | --- | ------------------ | ------------------------------------------ |
| SYNC                  | 0   | Bidirectional      | Document synchronization (step 1, 2, updates) |
| AWARENESS             | 1   | Bidirectional      | User presence (cursors, names, selections) |
| QUERY_AWARENESS       | 3   | Client → Server    | Request current awareness states           |
| SYNC_STATUS           | 102 | Client → Server → Client | Heartbeat + `hasLocalChanges` tracking |

**MESSAGE_SYNC_STATUS (102)**: The client sends its local version counter. The server echoes the raw bytes back unchanged (zero parsing cost). This enables the client to know when all local changes have reached the server, powering "Saving..." / "Saved" UI. It also doubles as a heartbeat for fast dead-connection detection (5s worst case).

### Server-Side Keepalive

The server sends WebSocket ping frames every **30 seconds**. If no pong is received before the next ping, the connection is closed. This catches dead clients (laptop lid closed, browser killed, network drop).

### Room Management

Each workspace ID maps to a room. Rooms track:

- Connected clients (for broadcasting updates)
- Shared awareness state (user presence)

When the last client disconnects from a room, a **60-second eviction timer** starts. If no new client connects within that window, the room is destroyed and its resources released. If a client reconnects before eviction, the timer is cancelled and the room stays alive.

### Relationship to `@epicenter/sync`

The server exposes the WebSocket endpoint. `@epicenter/sync` is the client-side provider that connects to it. Together they form the sync stack:

```typescript
// Server side
const server = createServer(blogClient, { port: 3913 });
server.start();
// Exposes: ws://localhost:3913/workspaces/blog/sync

// Client side
import { createSyncProvider } from '@epicenter/sync';

const provider = createSyncProvider({
  doc: myDoc,
  url: 'ws://localhost:3913/workspaces/blog/sync',
});
```

See `@epicenter/sync` for the client-side API (auth modes, status model, `hasLocalChanges`).

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
